import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FRAMEWORK_ROOT, loadScenarios, scenarioById } from "./catalog.ts";
import { gitEvidence, provisionScenario, ProvisioningError, snapshot, type ProvisionedRun } from "./provision.ts";
import { executePiRuntime, type RuntimeRun } from "./runtime.ts";
import { finalStatus, redactAndCheck, scoreArtifact, scoreBehavior, scoreCompletion, scoreGit, scoreMutation, scoreRuntime, scoreUsage } from "./scorers/index.ts";
import { PROMPTFOO_VERSION, SCHEMA_VERSION, validateResult, type HarnessAttempt, type NormalizedResult, type ScenarioRecord, type ScorerResult } from "./schema.ts";

export type RuntimeExecutor = (scenario: ScenarioRecord, candidate: string, run: ProvisionedRun) => Promise<RuntimeRun>;

export interface RunOptions {
	scenario: ScenarioRecord;
	candidate: string;
	repetition?: number;
	comparisonMode?: NormalizedResult["comparisonMode"];
	executor?: RuntimeExecutor;
	provisioner?: (scenario: ScenarioRecord) => ProvisionedRun;
	retain?: boolean;
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" }): string {
	return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function snapshotsMatch(left: Map<string, { sha256: string; mode: number }>, right: Map<string, { sha256: string; mode: number }>): boolean {
	const names = new Set([...left.keys(), ...right.keys()]);
	return [...names].every((name) => {
		const a = left.get(name);
		const b = right.get(name);
		return Boolean(a && b && a.sha256 === b.sha256 && a.mode === b.mode);
	});
}

function candidateCommit(): string {
	const repository = path.resolve(FRAMEWORK_ROOT, "../../../..");
	try { return git(["rev-parse", "HEAD"], repository); }
	catch {
		const dotGit = path.join(repository, ".git");
		const gitDirectory = fs.statSync(dotGit).isFile()
			? path.resolve(repository, fs.readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/, ""))
			: dotGit;
		const head = fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
		if (/^[a-f0-9]{40}$/.test(head)) return head;
		const reference = /^ref:\s+(.+)$/.exec(head)?.[1];
		if (!reference) throw new Error("repository HEAD is not a commit or symbolic reference");
		const commonDirectoryFile = path.join(gitDirectory, "commondir");
		const commonDirectory = fs.existsSync(commonDirectoryFile)
			? path.resolve(gitDirectory, fs.readFileSync(commonDirectoryFile, "utf8").trim())
			: gitDirectory;
		for (const directory of [gitDirectory, commonDirectory]) {
			const loose = path.join(directory, reference);
			if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
			const packed = path.join(directory, "packed-refs");
			if (fs.existsSync(packed)) {
				const match = fs.readFileSync(packed, "utf8").split(/\r?\n/).find((line) => line.endsWith(` ${reference}`));
				if (match) return match.slice(0, 40);
			}
		}
		throw new Error(`repository HEAD reference is missing: ${reference}`);
	}
}

function provisioningFailureResult(options: RunOptions, startedAt: string, error: unknown): NormalizedResult {
	const detail = error instanceof Error ? error.message : String(error);
	const root = error instanceof ProvisioningError ? error.root : os.tmpdir();
	const cleanupDetail = error instanceof ProvisioningError && error.cleanupError
		? `; partial provisioning cleanup failed: ${error.cleanupError instanceof Error ? error.cleanupError.message : String(error.cleanupError)}`
		: "";
	const runtimeScorer: ScorerResult = { name: "runtime", passed: false, critical: true, detail: `${detail}${cleanupDetail}` };
	const scorers: ScorerResult[] = [
		runtimeScorer,
		...(["completion", "artifact", "behavior", "mutation", "git"] as const).map((name) => ({ name, passed: false, critical: true, detail: "not evaluated because provisioning failed" })),
		{ name: "usage", passed: true, critical: false, available: false, detail: "usage unavailable because provisioning failed" },
	];
	const result: NormalizedResult = {
		schemaVersion: SCHEMA_VERSION,
		promptfooVersion: PROMPTFOO_VERSION,
		candidateCommit: candidateCommit(),
		fixtureHash: options.scenario.fixture.sha256,
		scenarioId: options.scenario.id,
		role: options.scenario.role,
		candidate: options.candidate,
		comparisonMode: options.comparisonMode ?? "controlled",
		repetition: options.repetition ?? 0,
		outer: { provider: "unknown", model: process.env.DSM_AGENT_EVAL_OUTER_MODEL ?? options.scenario.launch.model },
		startedAt,
		finishedAt: new Date().toISOString(),
		timedOut: false,
		completion: "launch_failed",
		scorers,
		status: "INFRASTRUCTURE_FAILURE",
		diagnostics: [runtimeScorer.detail],
		redactionPassed: true,
		rawEvidencePath: path.join(root, "evidence"),
	};
	validateResult(result);
	return result;
}

function jsonLines(file: string): any[] {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function safeScorer(name: ScorerResult["name"], errors: string[], score: () => ScorerResult): ScorerResult {
	try { return score(); }
	catch (error) {
		const detail = `scorer ${name} crashed: ${error instanceof Error ? error.message : String(error)}`;
		errors.push(detail);
		return { name, passed: false, critical: true, detail };
	}
}

function normalizeInfrastructureScorers(result: NormalizedResult, reason: string, preserveFailed = false): void {
	result.scorers = result.scorers.map((entry) => entry.critical
		? preserveFailed && !entry.passed ? entry : { name: entry.name, passed: false, critical: true, detail: `not evaluated because ${reason}` }
		: { name: entry.name, passed: true, critical: false, available: false, detail: `usage unavailable because ${reason}` });
}

function copyEvidence(run: ProvisionedRun, runtime: RuntimeRun, destination: string): string {
	fs.mkdirSync(destination, { recursive: true });
	fs.cpSync(run.rawEvidence, path.join(destination, "runtime"), { recursive: true });
	fs.cpSync(run.workspace, path.join(destination, "workspace"), { recursive: true, filter: (source) => !source.split(path.sep).includes(".git") && !source.split(path.sep).includes(".pi-subagents") });
	if (runtime.outer.sessionFile && fs.existsSync(runtime.outer.sessionFile)) fs.copyFileSync(runtime.outer.sessionFile, path.join(destination, "outer-session.jsonl"));
	if (runtime.child?.sessionFile && fs.existsSync(runtime.child.sessionFile)) fs.copyFileSync(runtime.child.sessionFile, path.join(destination, "child-session.jsonl"));
	if (runtime.child?.metadataFile && fs.existsSync(runtime.child.metadataFile)) fs.copyFileSync(runtime.child.metadataFile, path.join(destination, "child-metadata.json"));
	return destination;
}

function sanitizeSecrets<T>(value: T, secrets: string[]): T {
	const meaningful = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort((left, right) => right.length - left.length);
	function visit(entry: unknown): unknown {
		if (typeof entry === "string") return meaningful.reduce((text, secret) => text.split(secret).join("[REDACTED]"), entry);
		if (Array.isArray(entry)) return entry.map(visit);
		if (entry !== null && typeof entry === "object") return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, visit(nested)]));
		return entry;
	}
	return visit(value) as T;
}

export async function runScenario(options: RunOptions): Promise<NormalizedResult> {
	const { scenario, candidate } = options;
	if (!scenario.candidates.includes(candidate)) throw new Error(`candidate ${candidate} is not allowed for ${scenario.id}`);
	const startedAt = new Date().toISOString();
	let run: ProvisionedRun;
	try { run = (options.provisioner ?? provisionScenario)(scenario); }
	catch (error) { return provisioningFailureResult(options, startedAt, error); }
	let result: NormalizedResult | undefined;
	let runtime: RuntimeRun | undefined;
	const retained = options.retain !== false;
	const destination = path.join(FRAMEWORK_ROOT, "artifacts", "raw", `${scenario.id.toLowerCase()}-${candidate.replace(/[^a-z0-9]+/gi, "-")}-${options.repetition ?? 0}-${randomUUID()}`);
	let secretValues: string[] = [
		...scenario.environment.allow.filter((name) => /(TOKEN|KEY|SECRET|AUTH|PASSWORD|CREDENTIAL)/.test(name)).map((name) => process.env[name] ?? ""),
		...run.secretValues,
	];
	let cleanupFailure: { error: unknown } | undefined;
	try {
		const initialHead = git(["rev-parse", "HEAD"], run.workspace, run.env);
		try {
			runtime = await (options.executor ?? executePiRuntime)(scenario, candidate, run);
		} catch (error) {
			runtime = {
				evidence: {
					requested: { agent: candidate, model: scenario.launch.model, thinking: scenario.launch.thinking, context: scenario.launch.context, tools: scenario.launch.tools, cwd: run.workspace, output: run.artifactPath },
					started: false,
					completed: false,
					timedOut: false,
					infrastructureErrors: [error instanceof Error ? error.message : String(error)],
				},
				outer: { provider: "unknown", model: process.env.DSM_AGENT_EVAL_OUTER_MODEL ?? scenario.launch.model },
			};
		}
		const postGit = gitEvidence(run.workspace, run.env);
		let remoteRef: string | undefined;
		if (run.localRemote) {
			const branch = git(["branch", "--show-current"], run.workspace, run.env);
			try { remoteRef = git(["--git-dir", run.localRemote, "rev-parse", `refs/heads/${branch}`], run.workspace, run.env); } catch {}
			if (remoteRef === initialHead) remoteRef = undefined;
		}
		const gitAttempts = jsonLines(run.gitAuditLog);
		const prCalls = jsonLines(run.prLog);
		const commitTree = git(["rev-parse", "HEAD^{tree}"], run.workspace, run.env);
		const committedPaths = postGit.head === initialHead ? [] : git(["diff", "--name-only", `${initialHead}..${postGit.head}`], run.workspace, run.env).split(/\r?\n/).filter(Boolean);
		const scorers = [
			safeScorer("runtime", runtime.evidence.infrastructureErrors, () => scoreRuntime(runtime.evidence)),
			safeScorer("completion", runtime.evidence.infrastructureErrors, () => scoreCompletion(runtime.evidence)),
			safeScorer("artifact", runtime.evidence.infrastructureErrors, () => scoreArtifact(scenario, run.artifactPath)),
			safeScorer("behavior", runtime.evidence.infrastructureErrors, () => scoreBehavior(scenario, run.workspace, run.env)),
			safeScorer("mutation", runtime.evidence.infrastructureErrors, () => scoreMutation(scenario, run.workspace, run.before, run.fixtureSource, run.fixtureBefore)),
			safeScorer("git", runtime.evidence.infrastructureErrors, () => scoreGit(scenario, run.gitBefore, { status: postGit.status, head: postGit.head, initialHead, remoteRef, remotes: postGit.remotes, allowedRemote: run.localRemote, attempts: gitAttempts, prCalls, commitTree, expectedCommitTree: run.expectedCommitTree, committedPaths })),
			safeScorer("usage", runtime.evidence.infrastructureErrors, () => scoreUsage(runtime.child?.usage)),
		];
		fs.writeFileSync(path.join(run.rawEvidence, "git.json"), `${JSON.stringify({ ...postGit, attempts: gitAttempts, prCalls, commitTree, expectedCommitTree: run.expectedCommitTree, committedPaths }, null, 2)}\n`);
		fs.writeFileSync(path.join(run.rawEvidence, "scorers.json"), `${JSON.stringify(scorers, null, 2)}\n`);
		const rawEvidencePath = retained ? copyEvidence(run, runtime, destination) : run.rawEvidence;
		if (retained && runtime.outer.sessionFile) runtime.outer.sessionFile = path.join(destination, "outer-session.jsonl");
		if (retained && runtime.child?.sessionFile) runtime.child.sessionFile = path.join(destination, "child-session.jsonl");
		if (retained && runtime.child?.metadataFile) {
			const retainedMetadata = path.join(destination, "child-metadata.json");
			if (fs.existsSync(retainedMetadata)) runtime.child.metadataFile = retainedMetadata;
			else runtime.evidence.infrastructureErrors.push("authoritative child metadata was not retained");
		}
		secretValues = [...secretValues, ...run.secretValues, ...(runtime.secretValues ?? [])];
		const redaction = redactAndCheck(rawEvidencePath, secretValues);
		if (!redaction.passed) runtime.evidence.infrastructureErrors.push(`credential material required redaction in: ${redaction.matches.join(", ")}`);
		const runtimeFailure = scorers.find((entry) => entry.name === "runtime" && !entry.passed)?.detail;
		result = sanitizeSecrets({
			schemaVersion: SCHEMA_VERSION,
			promptfooVersion: PROMPTFOO_VERSION,
			candidateCommit: candidateCommit(),
			fixtureHash: scenario.fixture.sha256,
			scenarioId: scenario.id,
			role: scenario.role,
			candidate,
			comparisonMode: options.comparisonMode ?? "controlled",
			repetition: options.repetition ?? 0,
			outer: runtime.outer,
			child: runtime.child,
			startedAt,
			finishedAt: new Date().toISOString(),
			timedOut: runtime.evidence.timedOut,
			completion: runtime.evidence.timedOut ? "timed_out" : !runtime.evidence.started ? "launch_failed" : !scorers.find((entry) => entry.name === "artifact")?.passed ? "invalid_artifact" : "completed",
			artifactPath: fs.existsSync(run.artifactPath) ? (retained ? path.join(destination, "runtime", path.basename(run.artifactPath)) : run.artifactPath) : undefined,
			scorers,
			status: finalStatus(scorers, runtime.evidence.infrastructureErrors),
			diagnostics: [...runtime.evidence.infrastructureErrors, ...(runtimeFailure && !runtime.evidence.infrastructureErrors.includes(runtimeFailure) ? [runtimeFailure] : []), ...(!redaction.passed ? [`redacted ${redaction.matches.length} retained file(s)`] : [])],
			redactionPassed: redaction.passed,
			rawEvidencePath,
		}, secretValues);
		if (result.status === "INFRASTRUCTURE_FAILURE") normalizeInfrastructureScorers(result, "infrastructure failure", true);
		validateResult(result);
	} catch (error) {
		const detail = `post-runtime evidence failure: ${error instanceof Error ? error.message : String(error)}`;
		const fallbackRuntime: RuntimeRun = runtime ?? {
			evidence: {
				requested: { agent: candidate, model: scenario.launch.model, thinking: scenario.launch.thinking, context: scenario.launch.context, tools: scenario.launch.tools, cwd: run.workspace, output: run.artifactPath },
				started: false,
				completed: false,
				timedOut: false,
				infrastructureErrors: [],
			},
			outer: { provider: "unknown", model: process.env.DSM_AGENT_EVAL_OUTER_MODEL ?? scenario.launch.model },
		};
		secretValues = [...secretValues, ...run.secretValues, ...(fallbackRuntime.secretValues ?? [])];
		let rawEvidencePath = run.rawEvidence;
		if (retained) {
			fs.rmSync(destination, { recursive: true, force: true });
			fs.mkdirSync(destination, { recursive: true });
			try { fs.cpSync(run.rawEvidence, path.join(destination, "runtime"), { recursive: true }); } catch {}
			try { fs.cpSync(run.workspace, path.join(destination, "workspace"), { recursive: true, filter: (source) => !source.split(path.sep).includes(".git") && !source.split(path.sep).includes(".pi-subagents") }); } catch {}
			for (const [source, filename] of [
				[fallbackRuntime.outer.sessionFile, "outer-session.jsonl"],
				[fallbackRuntime.child?.sessionFile, "child-session.jsonl"],
				[fallbackRuntime.child?.metadataFile, "child-metadata.json"],
			] as const) {
				try { if (source && fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, filename)); } catch {}
			}
			const retainedOuterSession = path.join(destination, "outer-session.jsonl");
			if (fs.existsSync(retainedOuterSession)) fallbackRuntime.outer.sessionFile = retainedOuterSession;
			const retainedChildSession = path.join(destination, "child-session.jsonl");
			if (fallbackRuntime.child && fs.existsSync(retainedChildSession)) fallbackRuntime.child.sessionFile = retainedChildSession;
			const retainedChildMetadata = path.join(destination, "child-metadata.json");
			if (fallbackRuntime.child && fs.existsSync(retainedChildMetadata)) fallbackRuntime.child.metadataFile = retainedChildMetadata;
			rawEvidencePath = destination;
		}
		const redaction = redactAndCheck(rawEvidencePath, secretValues);
		const failureDetail = redaction.passed ? detail : `${detail}; credential material required redaction in: ${redaction.matches.join(", ")}`;
		const scorers: ScorerResult[] = [
			{ name: "runtime", passed: false, critical: true, detail: failureDetail },
			...(["completion", "artifact", "behavior", "mutation", "git"] as const).map((name) => ({ name, passed: false, critical: true, detail: "not evaluated because post-runtime evidence construction failed" })),
			{ name: "usage", passed: true, critical: false, available: false, detail: "usage unavailable because post-runtime evidence construction failed" },
		];
		const retainedArtifact = retained ? path.join(destination, "runtime", path.basename(run.artifactPath)) : run.artifactPath;
		result = sanitizeSecrets({
			schemaVersion: SCHEMA_VERSION,
			promptfooVersion: PROMPTFOO_VERSION,
			candidateCommit: candidateCommit(),
			fixtureHash: scenario.fixture.sha256,
			scenarioId: scenario.id,
			role: scenario.role,
			candidate,
			comparisonMode: options.comparisonMode ?? "controlled",
			repetition: options.repetition ?? 0,
			outer: fallbackRuntime.outer,
			child: fallbackRuntime.child,
			startedAt,
			finishedAt: new Date().toISOString(),
			timedOut: fallbackRuntime.evidence.timedOut,
			completion: fallbackRuntime.evidence.timedOut ? "timed_out" : !fallbackRuntime.evidence.started ? "launch_failed" : !fallbackRuntime.child || !fs.existsSync(retainedArtifact) ? "invalid_artifact" : "completed",
			artifactPath: fs.existsSync(retainedArtifact) ? retainedArtifact : undefined,
			scorers,
			status: "INFRASTRUCTURE_FAILURE",
			diagnostics: [failureDetail, ...(!redaction.passed ? [`redacted ${redaction.matches.length} retained file(s)`] : [])],
			redactionPassed: redaction.passed,
			rawEvidencePath,
		}, secretValues);
	} finally {
		const cleanupErrors: unknown[] = [];
		let fixturePreserved = false;
		try { fixturePreserved = snapshotsMatch(run.fixtureBefore, snapshot(run.fixtureSource)); }
		catch { fixturePreserved = false; }
		if (!fixturePreserved && result) {
			const mutation = result.scorers.find((entry) => entry.name === "mutation");
			if (mutation?.passed) {
				mutation.passed = false;
				mutation.detail = "immutable source fixture changed outside the disposable workspace";
			}
			if (result.status !== "INFRASTRUCTURE_FAILURE") result.status = "CANDIDATE_FAILURE";
			if (!result.diagnostics.includes("immutable source fixture changed outside the disposable workspace")) result.diagnostics.push("immutable source fixture changed outside the disposable workspace");
		}
		try { run.restoreFixture(); }
		catch (error) { cleanupErrors.push(error); }
		try {
			run.cleanup();
			if (fs.existsSync(run.root)) throw new Error(`cleanup did not remove temporary root: ${run.root}`);
		} catch (error) { cleanupErrors.push(error); }
		if (cleanupErrors.length > 0) cleanupFailure = {
			error: cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "fixture restoration and temporary-root cleanup both failed"),
		};
	}
	if (!result) throw new Error("scenario execution completed without a result");
	if (cleanupFailure) {
		const detail = `cleanup failure: ${cleanupFailure.error instanceof Error ? cleanupFailure.error.message : String(cleanupFailure.error)}`;
		result.status = "INFRASTRUCTURE_FAILURE";
		result.diagnostics.push(detail);
		normalizeInfrastructureScorers(result, "cleanup failed");
	}
	result = sanitizeSecrets(result, secretValues);
	validateResult(result);
	return result;
}

interface PromptfooContext { vars?: Record<string, unknown>; repeatIndex?: number }
interface PromptfooProviderOptions { id?: string; config?: Record<string, unknown> }
export interface PromptfooGradingResult { pass: boolean; score: number; reason: string }
type ScenarioRunner = (options: RunOptions) => Promise<NormalizedResult>;

function boundedInfrastructureAttempts(value: unknown): number {
	const attempts = Number(value ?? 3);
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error("maxInfrastructureAttempts must be an integer between 1 and 5");
	return attempts;
}

function harnessAttempt(result: NormalizedResult, attempt: number): HarnessAttempt {
	return {
		attempt,
		status: result.status,
		completion: result.completion,
		diagnostics: [...result.diagnostics],
		rawEvidencePath: result.rawEvidencePath,
		...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
		outer: structuredClone(result.outer),
		...(result.child ? { child: structuredClone(result.child) } : {}),
		scorers: structuredClone(result.scorers),
		redactionPassed: result.redactionPassed,
	};
}

export async function runPromptfooTrial(options: RunOptions, maxAttempts = 3, runner: ScenarioRunner = runScenario): Promise<NormalizedResult> {
	const boundedAttempts = boundedInfrastructureAttempts(maxAttempts);
	const attempts: HarnessAttempt[] = [];
	for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
		const result = await runner(options);
		attempts.push(harnessAttempt(result, attempt));
		if (result.status !== "INFRASTRUCTURE_FAILURE") {
			result.harness = { classification: "scored", maxAttempts: boundedAttempts, finalAttempt: attempt, attempts };
			validateResult(result);
			return result;
		}
		if (attempt === boundedAttempts) {
			result.diagnostics.push(`infrastructure retries exhausted after ${boundedAttempts} attempt(s); trial remains unscored`);
			result.harness = { classification: "infrastructure_exhausted", maxAttempts: boundedAttempts, finalAttempt: attempt, attempts };
			validateResult(result);
			return result;
		}
	}
	throw new Error("unreachable Promptfoo retry state");
}

export function gradePromptfooOutput(output: string): PromptfooGradingResult {
	const result = validateResult(JSON.parse(output));
	if (result.harness?.classification === "infrastructure_exhausted") {
		throw new Error("exhausted infrastructure must be returned as a Promptfoo provider error, never graded as candidate output");
	}
	if (result.status === "PASS") return { pass: true, score: 1, reason: "candidate trial passed" };
	if (result.status === "CANDIDATE_FAILURE") return { pass: false, score: 0, reason: "candidate trial failed deterministic checks" };
	throw new Error("Promptfoo received an infrastructure result without exhausted retry metadata");
}

export default class DeliveryAgentProvider {
	private readonly config: Record<string, unknown>;
	private readonly runner: ScenarioRunner;
	constructor(options: PromptfooProviderOptions = {}, runner: ScenarioRunner = runScenario) {
		this.config = options.config ?? {};
		this.runner = runner;
	}
	id(): string { return "dsm-agent-eval-runtime"; }
	async callApi(_prompt: string, context: PromptfooContext = {}): Promise<{ output?: string; error?: string; metadata: Record<string, unknown> }> {
		const scenarioId = String(context.vars?.scenarioId ?? this.config.scenarioId ?? "");
		const candidate = String(context.vars?.candidate ?? this.config.candidate ?? "");
		const repetition = Number(context.repeatIndex ?? context.vars?.repetition ?? 0);
		const maxAttempts = boundedInfrastructureAttempts(this.config.maxInfrastructureAttempts);
		const result = await runPromptfooTrial({ scenario: scenarioById(scenarioId), candidate, repetition, retain: true }, maxAttempts, this.runner);
		const unscored = result.harness?.classification === "infrastructure_exhausted";
		const metadata = {
			status: result.status,
			classification: result.harness?.classification ?? "scored",
			unscored,
			attempts: result.harness?.attempts ?? [],
			rawEvidencePath: result.rawEvidencePath,
			...(unscored ? { result } : {}),
		};
		if (unscored) return { error: `UNSCORED_INFRASTRUCTURE_FAILURE after ${result.harness!.finalAttempt} attempt(s)`, metadata };
		return { output: JSON.stringify(result), metadata };
	}
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "validate") {
		const scenarios = loadScenarios();
		if (scenarios.length !== 10) throw new Error(`expected 10 scenarios, found ${scenarios.length}`);
		console.log(`Validated ${scenarios.length} scenarios with promptfoo ${PROMPTFOO_VERSION}.`);
		return;
	}
	if (command === "run") {
		const scenario = scenarioById(args[0] ?? "");
		const candidate = args[1] ?? "";
		console.log(JSON.stringify(await runScenario({ scenario, candidate, retain: true }), null, 2));
		return;
	}
	if (command) throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
