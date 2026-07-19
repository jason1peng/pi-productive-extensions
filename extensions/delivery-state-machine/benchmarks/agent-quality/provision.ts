import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FIXTURES_ROOT } from "./catalog.ts";
import type { ScenarioRecord } from "./schema.ts";

export interface FileSnapshot {
	sha256: string;
	mode: number;
}

export interface ProvisionedRun {
	root: string;
	workspace: string;
	agentHome: string;
	rawEvidence: string;
	artifactPath: string;
	localRemote?: string;
	prLog: string;
	gitAuditLog: string;
	expectedCommitTree?: string;
	/** Credential-free environment for provisioning, controls, scoring, and Git inspection. */
	env: Record<string, string>;
	/** Ephemeral comparison-only values owned by the run lifecycle. Never retain or serialize. */
	secretValues: string[];
	before: Map<string, FileSnapshot>;
	fixtureSource: string;
	fixtureBefore: Map<string, FileSnapshot>;
	/** Production-owned restoration from candidate-inaccessible in-memory bytes and modes. */
	restoreFixture: () => void;
	gitBefore: string;
	cleanup: () => void;
}

export class ProvisioningError extends Error {
	constructor(message: string, readonly root: string, readonly cleanupError?: unknown, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProvisioningError";
	}
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): string {
	return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function copyDirectory(source: string, target: string): void {
	fs.cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true });
}

function expectedCommitTree(workspace: string, paths: string[], evidenceRoot: string, environment: Record<string, string>): string | undefined {
	if (paths.some((entry) => entry.includes("*"))) return undefined;
	const index = path.join(evidenceRoot, "expected-close.index");
	fs.copyFileSync(path.join(workspace, ".git", "index"), index);
	const env = { ...environment, GIT_INDEX_FILE: index };
	execFileSync("git", ["add", "--", ...paths], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
	const tree = execFileSync("git", ["write-tree"], { cwd: workspace, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	fs.rmSync(index, { force: true });
	return tree;
}

function writeCommandWrappers(binDirectory: string, realGit: string, gitAuditLog: string, prLog: string, scenarioId: string, credentialNames: string[]): void {
	const gitWrapper = `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(gitAuditLog)}, JSON.stringify({args}) + "\\n");\nconst env = {...process.env};\nfor (const name of ${JSON.stringify(credentialNames)}) delete env[name];\nconst result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: "inherit", env});\nif (result.error) { console.error(result.error.message); process.exit(127); }\nprocess.exit(result.status ?? 128);\n`;
	fs.writeFileSync(path.join(binDirectory, "git"), gitWrapper, { mode: 0o755 });
	for (const tool of ["gh", "glab"]) {
		const prWrapper = `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst { randomUUID } = require("node:crypto");\nconst args = process.argv.slice(2);\nconst url = "https://pr.invalid/${scenarioId.toLowerCase()}/" + randomUUID();\nappendFileSync(${JSON.stringify(prLog)}, JSON.stringify({tool: ${JSON.stringify(tool)}, args, url}) + "\\n");\nconsole.log(url);\n`;
		fs.writeFileSync(path.join(binDirectory, tool), prWrapper, { mode: 0o755 });
	}
}

export function snapshot(root: string): Map<string, FileSnapshot> {
	const result = new Map<string, FileSnapshot>();
	function visit(directory: string): void {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === ".pi-subagents") continue;
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (entry.isSymbolicLink()) throw new Error(`workspace symlink is not allowed: ${relative}`);
			if (entry.isDirectory()) visit(absolute);
			else {
				const stat = fs.statSync(absolute);
				result.set(relative, { sha256: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"), mode: stat.mode & 0o777 });
			}
		}
	}
	visit(root);
	return result;
}

function snapshotsMatch(left: Map<string, FileSnapshot>, right: Map<string, FileSnapshot>): boolean {
	const names = new Set([...left.keys(), ...right.keys()]);
	return [...names].every((name) => {
		const a = left.get(name);
		const b = right.get(name);
		return Boolean(a && b && a.sha256 === b.sha256 && a.mode === b.mode);
	});
}

interface FixtureAuthorityEntry {
	relative: string;
	content: Buffer;
	mode: number;
}

function captureFixtureAuthority(root: string, expected: Map<string, FileSnapshot>): FixtureAuthorityEntry[] {
	const entries = [...expected.entries()].map(([relative, metadata]) => {
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.split("/").includes("..")) {
			throw new Error(`fixture authority path escapes its root: ${relative}`);
		}
		const absolute = path.resolve(root, relative);
		if (path.relative(root, absolute).startsWith("..")) throw new Error(`fixture authority path escapes its root: ${relative}`);
		return { relative, content: Buffer.from(fs.readFileSync(absolute)), mode: metadata.mode };
	});
	validateFixtureAuthority(entries, expected);
	return entries;
}

function validateFixtureAuthority(authority: FixtureAuthorityEntry[], expected: Map<string, FileSnapshot>): void {
	const actual = new Map(authority.map((entry) => [entry.relative, {
		sha256: createHash("sha256").update(entry.content).digest("hex"),
		mode: entry.mode,
	}]));
	if (!snapshotsMatch(expected, actual)) throw new Error("immutable source fixture restoration authority does not match the original byte/mode snapshot");
}

function materializeFixtureAuthority(authority: FixtureAuthorityEntry[], target: string): void {
	for (const entry of authority) {
		const absolute = path.resolve(target, entry.relative);
		const relative = path.relative(target, absolute);
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`fixture restoration path escapes its root: ${entry.relative}`);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, Buffer.from(entry.content), { mode: entry.mode });
	}
}

interface DirectoryIdentity { dev: number; ino: number }

function directoryIdentity(target: string): DirectoryIdentity {
	const stat = fs.statSync(target);
	return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function removeCandidateDisplacedFixture(target: string, originalIdentity: DirectoryIdentity, parentBefore: Map<string, DirectoryIdentity>): void {
	const parent = path.dirname(target);
	const targetName = path.basename(target);
	for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
		if (entry.name === targetName) continue;
		const candidate = path.join(parent, entry.name);
		let identity: DirectoryIdentity;
		try { identity = directoryIdentity(candidate); } catch { continue; }
		const prior = parentBefore.get(entry.name);
		if (sameIdentity(identity, originalIdentity) && (!prior || !sameIdentity(prior, identity))) {
			fs.rmSync(candidate, { recursive: true, force: true });
		}
	}
}

function restoreDirectoryFromAuthority(authority: FixtureAuthorityEntry[], target: string, expected: Map<string, FileSnapshot>, originalIdentity: DirectoryIdentity, parentBefore: Map<string, DirectoryIdentity>): void {
	let preserved = false;
	try { preserved = snapshotsMatch(expected, snapshot(target)); }
	catch { preserved = false; }
	if (preserved) {
		removeCandidateDisplacedFixture(target, originalIdentity, parentBefore);
		return;
	}

	// Validate the parent-owned authority before touching the already-mutated target.
	validateFixtureAuthority(authority, expected);
	const parent = path.dirname(target);
	const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.restore-`));
	const displaced = path.join(parent, `.${path.basename(target)}.displaced-${randomUUID()}`);
	let targetDisplaced = false;
	let replacementInstalled = false;
	try {
		materializeFixtureAuthority(authority, temporary);
		if (!snapshotsMatch(expected, snapshot(temporary))) throw new Error("materialized fixture restoration authority failed verification");
		if (fs.existsSync(target)) {
			fs.renameSync(target, displaced);
			targetDisplaced = true;
		}
		try {
			fs.renameSync(temporary, target);
			replacementInstalled = true;
		} catch (error) {
			if (targetDisplaced) fs.renameSync(displaced, target);
			targetDisplaced = false;
			throw error;
		}
		if (!snapshotsMatch(expected, snapshot(target))) throw new Error("immutable source fixture restoration did not reproduce the original byte/mode snapshot");
		if (targetDisplaced) fs.rmSync(displaced, { recursive: true, force: true });
		targetDisplaced = false;
		removeCandidateDisplacedFixture(target, originalIdentity, parentBefore);
	} catch (error) {
		if (replacementInstalled && targetDisplaced) {
			fs.rmSync(target, { recursive: true, force: true });
			fs.renameSync(displaced, target);
			targetDisplaced = false;
		}
		throw error;
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
		// Never delete a displaced target on an error path: it is the last recoverable copy.
	}
}

function isolatedEnvironment(agentHome: string, workspace: string, binDirectory: string): Record<string, string> {
	return {
		HOME: agentHome,
		PI_CODING_AGENT_DIR: path.join(agentHome, ".pi", "agent"),
		PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
		TMPDIR: path.join(agentHome, "tmp"),
		PWD: workspace,
		USER: "dsm-eval",
		LOGNAME: "dsm-eval",
		LANG: "C.UTF-8",
	};
}

/** Add scenario-authorized values only at the Pi launch boundary. */
export function runtimeEnvironment(controlEnvironment: Record<string, string>, allow: string[]): Record<string, string> {
	const environment = { ...controlEnvironment };
	for (const name of allow) {
		if (name in environment) continue;
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	for (const name of Object.keys(environment)) {
		if (name === "PI_CODING_AGENT" || name.startsWith("PI_COMS_") || name.startsWith("PI_SUBAGENT_")) delete environment[name];
	}
	return environment;
}

function credentialValuesForScenario(scenario: ScenarioRecord): string[] {
	return scenario.environment.allow
		.filter((name) => /(TOKEN|KEY|SECRET|AUTH|PASSWORD|CREDENTIAL)/i.test(name))
		.map((name) => process.env[name] ?? "")
		.filter((value) => value.length >= 8);
}

function sanitizeDiagnostic(value: string, secrets: string[]): string {
	return [...new Set(secrets)].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}

export function provisionScenario(scenario: ScenarioRecord, base = os.tmpdir(), fixtureRoot = FIXTURES_ROOT): ProvisionedRun {
	const root = fs.mkdtempSync(path.join(base, `dsm-agent-eval-${scenario.id.toLowerCase()}-`));
	let restoreFixture: (() => void) | undefined;
	try {
		const workspace = path.join(root, "workspace");
		const agentHome = path.join(root, "agent-home");
		const rawEvidence = path.join(root, "evidence");
		const binDirectory = path.join(root, "bin");
		const prLog = path.join(rawEvidence, "pr-stub.jsonl");
		const gitAuditLog = path.join(rawEvidence, "git-commands.jsonl");
		fs.mkdirSync(agentHome, { recursive: true });
		fs.mkdirSync(path.join(agentHome, "tmp"), { recursive: true });
		fs.mkdirSync(rawEvidence, { recursive: true });
		fs.mkdirSync(binDirectory, { recursive: true });
		const env = isolatedEnvironment(agentHome, workspace, binDirectory);
		const fixtureSource = path.join(fixtureRoot, scenario.fixture.path);
		const fixtureBefore = snapshot(fixtureSource);
		const fixtureAuthority = captureFixtureAuthority(fixtureSource, fixtureBefore);
		const fixtureIdentity = directoryIdentity(fixtureSource);
		const fixtureParentBefore = new Map<string, DirectoryIdentity>();
		for (const entry of fs.readdirSync(path.dirname(fixtureSource), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const target = path.join(path.dirname(fixtureSource), entry.name);
			fixtureParentBefore.set(entry.name, directoryIdentity(target));
		}
		restoreFixture = () => restoreDirectoryFromAuthority(fixtureAuthority, fixtureSource, fixtureBefore, fixtureIdentity, fixtureParentBefore);
		copyDirectory(fixtureSource, workspace);
		fs.writeFileSync(path.join(workspace, ".gitignore"), `${fs.existsSync(path.join(workspace, ".gitignore")) ? fs.readFileSync(path.join(workspace, ".gitignore"), "utf8").trimEnd() + "\n" : ""}.pi-subagents/\n`, "utf8");
		run("git", ["init", "-q", "-b", "main"], env, workspace);
		run("git", ["add", "."], env, workspace);
		run("git", ["-c", "user.name=DSM Eval", "-c", "user.email=dsm-eval@example.invalid", "commit", "-qm", `fixture ${scenario.id} ${scenario.fixture.revision}`], env, workspace);
		let localRemote: string | undefined;
		if (scenario.remote.policy === "local-only") {
			localRemote = path.join(root, "remote.git");
			run("git", ["init", "--bare", "-q", localRemote], env);
			run("git", ["remote", "add", "origin", localRemote], env, workspace);
			run("git", ["push", "-q", "-u", "origin", "main"], env, workspace);
		}
		const setup = path.join(workspace, "setup.sh");
		if (fs.existsSync(setup)) run("bash", [setup], env, workspace);
		const expectedTree = scenario.role === "CLOSE" && scenario.expected.verdict === "MR_CREATED"
			? expectedCommitTree(workspace, scenario.mutation.allowedPaths, rawEvidence, env)
			: undefined;
		const credentialNames = scenario.environment.allow.filter((name) => /(TOKEN|KEY|SECRET|AUTH|PASSWORD|CREDENTIAL)/i.test(name));
		writeCommandWrappers(binDirectory, run("which", ["git"], env), gitAuditLog, prLog, scenario.id, credentialNames);
		const artifactPath = path.join(rawEvidence, scenario.artifact.filename);
		return {
			root,
			workspace,
			agentHome,
			rawEvidence,
			artifactPath,
			localRemote,
			prLog,
			gitAuditLog,
			expectedCommitTree: expectedTree,
			env,
			secretValues: [],
			before: snapshot(workspace),
			fixtureSource,
			fixtureBefore,
			restoreFixture,
			gitBefore: run("git", ["status", "--porcelain=v1", "--untracked-files=all"], env, workspace),
			cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
		};
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try { restoreFixture?.(); }
		catch (caught) { cleanupErrors.push(caught); }
		try {
			fs.rmSync(root, { recursive: true, force: true });
			if (fs.existsSync(root)) throw new Error(`cleanup did not remove partial provisioning root: ${root}`);
		} catch (caught) { cleanupErrors.push(caught); }
		const cleanupError = cleanupErrors.length === 0 ? undefined : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "partial fixture restoration and provisioning-root cleanup both failed");
		const secrets = credentialValuesForScenario(scenario);
		const detail = sanitizeDiagnostic(error instanceof Error ? error.message : String(error), secrets);
		const cleanupDetail = cleanupError === undefined ? undefined : sanitizeDiagnostic(cleanupError instanceof Error ? cleanupError.message : String(cleanupError), secrets);
		throw new ProvisioningError(`scenario provisioning failed: ${detail}`, root, cleanupDetail, { cause: error });
	}
}

export function gitEvidence(workspace: string, env: Record<string, string>): Record<string, string> {
	return {
		status: run("git", ["status", "--porcelain=v1", "--untracked-files=all"], env, workspace),
		diff: run("git", ["diff", "--no-ext-diff", "--binary"], env, workspace),
		cachedDiff: run("git", ["diff", "--cached", "--no-ext-diff", "--binary"], env, workspace),
		head: run("git", ["rev-parse", "HEAD"], env, workspace),
		branches: run("git", ["branch", "--format=%(refname:short)"], env, workspace),
		remotes: run("git", ["remote", "-v"], env, workspace),
	};
}
