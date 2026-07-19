import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { snapshot, type FileSnapshot } from "../provision.ts";
import type { FinalStatus, ScenarioRecord, ScorerResult } from "../schema.ts";

export interface RuntimeEvidence {
	requested: { agent: string; model: string; thinking: string; context: string; tools: string[]; cwd: string; output: string };
	effective?: { agent: string; provider: string; model: string; thinking: string; context: string; tools: string[]; cwd: string; sessionFile: string; metadataFile: string };
	started: boolean;
	completed: boolean;
	timedOut: boolean;
	infrastructureErrors: string[];
}

function result(name: ScorerResult["name"], passed: boolean, critical: boolean, detail: string, available = true): ScorerResult {
	return { name, passed, critical, detail, available };
}

function sameSnapshot(left: FileSnapshot | undefined, right: FileSnapshot | undefined): boolean {
	if (!left || !right) return left === right;
	const a = Buffer.from(`${left.sha256}:${left.mode}`);
	const b = Buffer.from(`${right.sha256}:${right.mode}`);
	return a.length === b.length && timingSafeEqual(a, b);
}

function pathAllowed(candidate: string, patterns: string[]): boolean {
	return patterns.some((pattern) => pattern.endsWith("/**") ? candidate === pattern.slice(0, -3) || candidate.startsWith(pattern.slice(0, -2)) : candidate === pattern);
}

export function scoreRuntime(evidence: RuntimeEvidence): ScorerResult {
	if (evidence.infrastructureErrors.length > 0) return result("runtime", false, true, evidence.infrastructureErrors.join("; "));
	if (!evidence.started) return result("runtime", false, true, "authoritative child start was not observed");
	if (!evidence.effective) return result("runtime", false, true, "effective child identity could not be resolved uniquely");
	const mismatches: string[] = (["agent", "model", "thinking", "context", "cwd"] as const).filter((key) => evidence.requested[key] !== evidence.effective?.[key]);
	const requestedProvider = evidence.requested.model.includes("/") ? evidence.requested.model.slice(0, evidence.requested.model.indexOf("/")) : "";
	if (!requestedProvider || evidence.effective.provider !== requestedProvider) mismatches.push("provider");
	if (!isDeepStrictEqual(evidence.requested.tools, evidence.effective.tools)) mismatches.push("tools");
	return result("runtime", mismatches.length === 0, true, mismatches.length === 0 ? "requested and effective runtime identity and tools match" : `runtime identity mismatch: ${mismatches.join(", ")}`);
}

export function scoreCompletion(evidence: RuntimeEvidence): ScorerResult {
	if (evidence.timedOut) return result("completion", false, true, "run timed out after authoritative child start");
	return result("completion", evidence.completed, true, evidence.completed ? "child completed" : "child did not complete");
}

const requiredEvidenceAliases: Record<string, readonly string[]> = {
	"final gate": ["final local fast gate"],
};

const evidenceAliases: Record<string, readonly string[]> = {
	"classification:pass": ["accept", "accepted", "approve", "approved", "supported", "pass with non blocking notes"],
	"supportedModel:single writer": ["single writer exclusive creation"],
	"excludedConcern:concurrent writers": ["hostile mutation and concurrent writers"],
};

function normalizedEvidenceText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesExpectedEvidence(actual: unknown, expected: unknown, field = ""): boolean {
	if (typeof actual === "string" && typeof expected === "string") {
		const actualText = normalizedEvidenceText(actual);
		const expectedText = normalizedEvidenceText(expected);
		const accepted = [expectedText, ...(evidenceAliases[`${field}:${expectedText}`] ?? [])];
		return accepted.includes(actualText);
	}
	if (Array.isArray(actual) || Array.isArray(expected)) {
		return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((entry, index) => matchesExpectedEvidence(entry, expected[index], field));
	}
	if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
		const actualRecord = actual as Record<string, unknown>;
		const expectedRecord = expected as Record<string, unknown>;
		const actualKeys = Object.keys(actualRecord).sort();
		const expectedKeys = Object.keys(expectedRecord).sort();
		return isDeepStrictEqual(actualKeys, expectedKeys) && expectedKeys.every((key) => matchesExpectedEvidence(actualRecord[key], expectedRecord[key], key));
	}
	return isDeepStrictEqual(actual, expected);
}

export function scoreArtifact(scenario: ScenarioRecord, artifactPath: string): ScorerResult {
	if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile() || fs.statSync(artifactPath).size === 0) return result("artifact", false, true, "required artifact is missing or empty");
	const content = fs.readFileSync(artifactPath, "utf8");
	const lines = content.split(/\r?\n/);
	const verdict = /^RESULT: ([A-Z_]+)$/.exec(lines[0] ?? "")?.[1];
	if (!verdict || !scenario.artifact.verdicts.includes(verdict as never)) return result("artifact", false, true, `artifact verdict is invalid: ${verdict ?? "missing"}`);
	let position = 0;
	for (const heading of scenario.artifact.headings) {
		const next = lines.findIndex((line, index) => index >= position && line === heading);
		if (next < 0) return result("artifact", false, true, `required heading is missing or out of order: ${heading}`);
		position = next + 1;
	}
	const normalized = normalizedEvidenceText(content);
	const missingEvidence = scenario.artifact.requiredEvidence.filter((term) => {
		const expected = normalizedEvidenceText(term);
		return ![expected, ...(requiredEvidenceAliases[expected] ?? [])].some((candidate) => normalized.includes(candidate));
	});
	if (missingEvidence.length > 0) return result("artifact", false, true, `required evidence is missing: ${missingEvidence.join(", ")}`);
	const evidenceBlocks = [...content.matchAll(/```eval-evidence\s*\r?\n([\s\S]*?)\r?\n```/g)];
	if (evidenceBlocks.length !== 1) return result("artifact", false, true, `expected exactly one eval-evidence block, found ${evidenceBlocks.length}`);
	let evidence: unknown;
	try { evidence = JSON.parse(evidenceBlocks[0][1]); }
	catch (error) { return result("artifact", false, true, `eval-evidence JSON is invalid: ${error instanceof Error ? error.message : String(error)}`); }
	const expectedEvidence = scenario.id === "REV-02" && verdict === "PASS"
		? { classification: "pass", supportedModel: "single-writer", excludedConcern: "none" }
		: scenario.artifact.expectedEvidence;
	if (!matchesExpectedEvidence(evidence, expectedEvidence)) return result("artifact", false, true, "eval-evidence does not match the scenario's hidden known outcome");
	return result("artifact", true, true, `artifact contract, structured hidden-outcome evidence, and verdict ${verdict} are valid`);
}

export interface BehaviorControlEvidence {
	kind: "focused" | "behavior";
	command: string;
	expectedExitCode: number;
	exitCode: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	error?: string;
}

export function runBehaviorControls(scenario: ScenarioRecord, workspace: string, env: Record<string, string>): BehaviorControlEvidence[] {
	return ([
		...scenario.controls.focused.map((command) => ({ kind: "focused" as const, command })),
		...scenario.controls.behavior.map((command) => ({ kind: "behavior" as const, command })),
	]).map(({ kind, command }) => {
		const execution = spawnSync("bash", ["-lc", command], { cwd: workspace, env, encoding: "utf8", timeout: 60_000 });
		return {
			kind,
			command,
			expectedExitCode: scenario.expected.behaviorExitCode,
			exitCode: execution.status,
			signal: execution.signal,
			stdout: execution.stdout ?? "",
			stderr: execution.stderr ?? "",
			...(execution.error ? { error: execution.error.message } : {}),
		};
	});
}

export function scoreBehaviorEvidence(controls: BehaviorControlEvidence[]): ScorerResult {
	const failures = controls.filter((entry) => entry.error || entry.exitCode !== entry.expectedExitCode).map((entry) => `${entry.command} exited ${entry.exitCode ?? entry.signal ?? "unknown"}${entry.error ? ` (${entry.error})` : ""}`);
	return result("behavior", failures.length === 0, true, failures.length === 0 ? "all scenario controls produced the expected outcome" : failures.join("; "));
}

export function scoreBehavior(scenario: ScenarioRecord, workspace: string, env: Record<string, string>): ScorerResult {
	return scoreBehaviorEvidence(runBehaviorControls(scenario, workspace, env));
}

export function scoreMutation(scenario: ScenarioRecord, workspace: string, before: Map<string, FileSnapshot>, fixtureSource?: string, fixtureBefore?: Map<string, FileSnapshot>): ScorerResult {
	const after = snapshot(workspace);
	const changed = new Set([...before.keys(), ...after.keys()].filter((name) => !sameSnapshot(before.get(name), after.get(name))));
	const unauthorized = [...changed].filter((name) => !pathAllowed(name, scenario.mutation.allowedPaths));
	const preservationFailures = (scenario.mutation.preservePaths ?? []).filter((name) => !sameSnapshot(before.get(name), after.get(name)));
	let fixtureChanged: string[] = [];
	try {
		const fixtureAfter = fixtureSource && fixtureBefore ? snapshot(fixtureSource) : undefined;
		if (fixtureAfter && fixtureBefore) fixtureChanged = [...new Set([...fixtureBefore.keys(), ...fixtureAfter.keys()])].filter((name) => !sameSnapshot(fixtureBefore.get(name), fixtureAfter.get(name)));
	} catch (error) {
		fixtureChanged = [`unavailable (${error instanceof Error ? error.message : String(error)})`];
	}
	const failures = [...unauthorized.map((name) => `unauthorized path changed: ${name}`), ...preservationFailures.map((name) => `preserved path changed: ${name}`), ...fixtureChanged.map((name) => `immutable source fixture changed: ${name}`)];
	return result("mutation", failures.length === 0, true, failures.length === 0 ? `workspace mutations stayed within policy (${[...changed].join(", ") || "none"})` : failures.join("; "));
}

interface GitAttempt { args: string[] }
interface PrCall { tool: string; args: string[]; url: string }

function gitCommand(args: string[]): string | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(arg)) { index += 2; continue; }
		if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=")) { index += 1; continue; }
		if (arg.startsWith("-")) { index += 1; continue; }
		return arg;
	}
	return undefined;
}

function attemptedGitOperation(args: string[]): string | undefined {
	const command = gitCommand(args);
	if (!command) return undefined;
	if (["add", "rm", "mv"].includes(command)) return "stage";
	if (["commit", "push"].includes(command)) return command;
	if (["reset", "clean", "restore", "checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "stash"].includes(command)) return command;
	if (command === "branch") {
		const branchArgs = args.slice(args.indexOf(command) + 1);
		const listing = branchArgs.some((arg) => ["--list", "--all", "-a", "--remotes", "-r", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--show-current", "--format"].includes(arg) || arg.startsWith("--format="));
		if (branchArgs.some((arg) => /^-[dDmMcf]$/.test(arg)) || (!listing && branchArgs.some((arg) => !arg.startsWith("-")))) return "branch-mutation";
	}
	if (["update-ref", "symbolic-ref"].includes(command) && args.some((arg) => arg.startsWith("refs/heads/"))) return "branch-mutation";
	if (command === "remote" && args.some((arg) => ["add", "remove", "rm", "rename", "set-url"].includes(arg))) return "remote-mutation";
	return undefined;
}

export function scoreGit(scenario: ScenarioRecord, beforeStatus: string, after: {
	status: string;
	head: string;
	initialHead: string;
	remoteRef?: string;
	remotes: string;
	beforeBranches: string;
	branches: string;
	allowedRemote?: string;
	attempts: GitAttempt[];
	prCalls: PrCall[];
	commitTree?: string;
	expectedCommitTree?: string;
	committedPaths: string[];
}): ScorerResult {
	const allowed = new Set(scenario.mutation.allowedGitOperations);
	const failures: string[] = [];
	const remoteUrls = after.remotes.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/)[1]).filter(Boolean);
	if (remoteUrls.some((url) => !after.allowedRemote || path.resolve(url) !== path.resolve(after.allowedRemote))) failures.push("real or unexpected Git remote is forbidden");
	for (const attempt of after.attempts) {
		const operation = attemptedGitOperation(attempt.args);
		if (operation && !allowed.has(operation as never)) failures.push(`forbidden Git operation attempted: ${operation}`);
	}
	if (!allowed.has("branch-mutation") && after.branches !== after.beforeBranches) failures.push("branch set changed without authorization");
	if (!allowed.has("commit") && after.head !== after.initialHead) failures.push("commit was not allowed");
	if (!allowed.has("push") && after.remoteRef) failures.push("push was not allowed");
	if (!allowed.has("create-pr-stub") && after.prCalls.length > 0) failures.push("PR stub was not allowed");
	if (scenario.role === "CLOSE" && scenario.expected.verdict === "MR_CREATED") {
		const expectedPaths = [...scenario.mutation.allowedPaths].sort();
		if (after.head === after.initialHead) failures.push("expected close commit is missing");
		if (after.commitTree !== after.expectedCommitTree) failures.push("close commit tree does not exactly match the reviewed candidate");
		if (!isDeepStrictEqual([...after.committedPaths].sort(), expectedPaths)) failures.push("close commit paths do not exactly match the reviewed candidate paths");
		if (after.status !== "") failures.push("reviewed candidate is not clean after close");
		if (after.remoteRef !== after.head) failures.push("intended local remote ref does not match the close commit");
		const validPrCalls = after.prCalls.filter((call) => (call.tool === "gh" && isDeepStrictEqual(call.args.slice(0, 2), ["pr", "create"])) || (call.tool === "glab" && isDeepStrictEqual(call.args.slice(0, 2), ["mr", "create"])));
		if (validPrCalls.length !== 1) failures.push(`expected exactly one valid PR stub create call, found ${validPrCalls.length}`);
		if (validPrCalls.some((call) => !/^https:\/\/pr\.invalid\/[a-z0-9-]+\/[a-f0-9-]+$/.test(call.url))) failures.push("PR stub URL is missing or not parseable");
	}
	if (scenario.role === "CLOSE" && scenario.expected.verdict === "FAIL" && after.status !== beforeStatus) failures.push("fail-closed scenario changed Git status");
	return result("git", failures.length === 0, true, failures.length === 0 ? "Git command history and resulting state match policy" : [...new Set(failures)].join("; "));
}

export function scoreUsage(usage: unknown): ScorerResult {
	return usage === undefined
		? result("usage", true, false, "optional child usage telemetry unavailable; no values guessed", false)
		: result("usage", true, false, "child usage telemetry recorded separately from outer usage");
}

export function finalStatus(scorers: ScorerResult[], infrastructureErrors: string[]): FinalStatus {
	if (infrastructureErrors.length > 0 || scorers.find((entry) => entry.name === "runtime" && !entry.passed)) return "INFRASTRUCTURE_FAILURE";
	if (scorers.some((entry) => entry.critical && !entry.passed)) return "CANDIDATE_FAILURE";
	return "PASS";
}

export function redactAndCheck(root: string, secrets: string[]): { passed: boolean; matches: string[] } {
	const matches: string[] = [];
	const meaningful = secrets.filter((value) => value.length >= 8);
	function visit(directory: string): void {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(target);
			else {
				let content: string;
				try { content = fs.readFileSync(target, "utf8"); } catch { continue; }
				for (const secret of meaningful) {
					if (content.includes(secret)) {
						matches.push(path.relative(root, target));
						fs.writeFileSync(target, content.split(secret).join("[REDACTED]"), "utf8");
						content = content.split(secret).join("[REDACTED]");
					}
				}
			}
		}
	}
	visit(root);
	return { passed: matches.length === 0, matches };
}
