import * as path from "node:path";

export const SCHEMA_VERSION = 1 as const;
export const PROMPTFOO_VERSION = "0.121.19" as const;

export const CANDIDATE_PAIRS = {
	IMPLEMENT: ["dsm.implementer", "worker"],
	VERIFY: ["dsm.verifier", "reviewer"],
	REVIEW: ["dsm.reviewer", "reviewer"],
	CLOSE: ["dsm.closer", "delegate"],
	RETRO: ["dsm.retrospective", "delegate"],
} as const;

export type Role = keyof typeof CANDIDATE_PAIRS;
export type Candidate = (typeof CANDIDATE_PAIRS)[Role][number];
export type ExpectedVerdict = "PASS" | "FAIL" | "PASS_WITH_NON_BLOCKING_NOTES" | "MR_CREATED" | "DONE";
export type FinalStatus = "PASS" | "CANDIDATE_FAILURE" | "INFRASTRUCTURE_FAILURE";
export type ScorerName = "runtime" | "completion" | "artifact" | "behavior" | "mutation" | "git" | "usage";

export interface ScenarioRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	id: string;
	role: Role;
	candidates: readonly [string, string];
	fixture: { path: string; revision: string; sha256: string };
	task: string;
	invariants: string[];
	exclusions: string[];
	expected: { verdict: ExpectedVerdict; behaviorExitCode: number };
	launch: {
		model: string;
		thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
		context: "fresh" | "fork";
		tools: string[];
		timeoutMs: number;
		repetitions: number;
	};
	mutation: {
		allowedPaths: string[];
		allowedGitOperations: Array<"none" | "stage" | "commit" | "push" | "create-pr-stub">;
		preservePaths?: string[];
	};
	controls: { focused: string[]; behavior: string[] };
	artifact: { filename: string; verdicts: ExpectedVerdict[]; headings: string[]; requiredEvidence: string[]; expectedEvidence: Record<string, unknown> };
	remote: { policy: "none" | "local-only"; url?: string; prStub: boolean };
	environment: { inherit: false; allow: string[] };
	scorers: ScorerName[];
	criticalFailures: string[];
}

export interface ScorerResult {
	name: ScorerName;
	passed: boolean;
	critical: boolean;
	detail: string;
	available?: boolean;
}

export interface UsageRecord {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
}

export interface HarnessAttempt {
	attempt: number;
	status: FinalStatus;
	completion: NormalizedResult["completion"];
	diagnostics: string[];
	rawEvidencePath: string;
	artifactPath?: string;
	outer: NormalizedResult["outer"];
	child?: NormalizedResult["child"];
	scorers: ScorerResult[];
	redactionPassed: boolean;
}

export interface HarnessOutcome {
	classification: "scored" | "infrastructure_exhausted";
	maxAttempts: number;
	finalAttempt: number;
	attempts: HarnessAttempt[];
}

export interface NormalizedResult {
	schemaVersion: typeof SCHEMA_VERSION;
	promptfooVersion: typeof PROMPTFOO_VERSION;
	candidateCommit: string;
	fixtureHash: string;
	scenarioId: string;
	role: Role;
	candidate: string;
	comparisonMode: "controlled" | "native" | "canary";
	repetition: number;
	outer: { provider: string; model: string; sessionFile?: string; usage?: UsageRecord };
	child?: {
		agent: string;
		provider: string;
		model: string;
		thinking: string;
		context: string;
		tools: string[];
		cwd: string;
		sessionFile: string;
		metadataFile: string;
		usage?: UsageRecord;
	};
	startedAt: string;
	finishedAt: string;
	timedOut: boolean;
	completion: "completed" | "timed_out" | "launch_failed" | "invalid_artifact";
	artifactPath?: string;
	scorers: ScorerResult[];
	status: FinalStatus;
	diagnostics: string[];
	redactionPassed: boolean;
	rawEvidencePath: string;
	harness?: HarnessOutcome;
}

const safeId = /^[A-Z]{3}-\d{2}$/;
const safeEnv = /^(HOME|PATH|TMPDIR|TEMP|TMP|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LC_[A-Z_]+|NODE_PATH|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|PI_[A-Z0-9_]*(?:TOKEN|KEY)|ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AWS_[A-Z0-9_]+)$/;
const gitOperations = new Set(["none", "stage", "commit", "push", "create-pr-stub"]);
const scorerNames = new Set(["runtime", "completion", "artifact", "behavior", "mutation", "git", "usage"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
	return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
		|| (Array.isArray(value) && value.every(isJsonValue))
		|| (isObject(value) && Object.values(value).every(isJsonValue));
}

function assertString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
}

export function assertSafeRelativePath(value: unknown, field: string): asserts value is string {
	assertString(value, field);
	if (path.isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes("..")) {
		throw new Error(`${field} must stay within the scenario root`);
	}
}

function assertStringArray(value: unknown, field: string, allowEmpty = false): asserts value is string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a ${allowEmpty ? "" : "non-empty "}string array`);
	value.forEach((entry, index) => assertString(entry, `${field}[${index}]`));
}

function assertExactKeys(value: Record<string, unknown>, field: string, required: string[], optional: string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	const missing = required.filter((key) => !(key in value));
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (missing.length > 0) throw new Error(`${field} is missing required fields: ${missing.join(", ")}`);
	if (unknown.length > 0) throw new Error(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
}

function validateUsage(value: unknown, field: string): void {
	if (!isObject(value)) throw new Error(`${field} must be an object`);
	assertExactKeys(value, field, [], ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"]);
	if (Object.keys(value).length === 0) throw new Error(`${field} must contain telemetry or be omitted`);
	for (const key of Object.keys(value)) assertFiniteNonNegative(value[key], `${field}.${key}`);
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
	assertString(value, field);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
}

export function validateScenario(value: unknown): ScenarioRecord {
	if (!isObject(value)) throw new Error("scenario must be an object");
	if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported scenario schemaVersion: ${String(value.schemaVersion)}`);
	assertString(value.id, "id");
	if (!safeId.test(value.id)) throw new Error("id must use the stable XXX-00 form");
	if (!(value.role in CANDIDATE_PAIRS)) throw new Error(`unknown role: ${String(value.role)}`);
	const role = value.role as Role;
	if (!Array.isArray(value.candidates) || value.candidates.length !== 2 || value.candidates.some((candidate, index) => candidate !== CANDIDATE_PAIRS[role][index])) {
		throw new Error(`unknown or mismatched candidates for ${role}`);
	}
	if (!isObject(value.fixture)) throw new Error("fixture must be an object");
	assertSafeRelativePath(value.fixture.path, "fixture.path");
	assertString(value.fixture.revision, "fixture.revision");
	if (typeof value.fixture.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.fixture.sha256)) throw new Error("fixture.sha256 must be a lowercase SHA-256");
	assertString(value.task, "task");
	assertStringArray(value.invariants, "invariants");
	assertStringArray(value.exclusions, "exclusions", true);
	if (!isObject(value.expected) || !["PASS", "FAIL", "PASS_WITH_NON_BLOCKING_NOTES", "MR_CREATED", "DONE"].includes(String(value.expected.verdict)) || !Number.isInteger(value.expected.behaviorExitCode)) throw new Error("expected outcome is missing or invalid");
	if (!isObject(value.launch)) throw new Error("launch must be an object");
	assertString(value.launch.model, "launch.model");
	if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value.launch.thinking))) throw new Error("launch.thinking is invalid");
	if (!['fresh', 'fork'].includes(String(value.launch.context))) throw new Error("launch.context is invalid");
	assertStringArray(value.launch.tools, "launch.tools");
	if (!Number.isInteger(value.launch.timeoutMs) || Number(value.launch.timeoutMs) < 1_000) throw new Error("launch.timeoutMs must be at least 1000");
	if (!Number.isInteger(value.launch.repetitions) || Number(value.launch.repetitions) < 1) throw new Error("launch.repetitions must be positive");
	if (!isObject(value.mutation)) throw new Error("every scenario requires a mutation policy");
	if (!Array.isArray(value.mutation.allowedPaths)) throw new Error("mutation.allowedPaths must be an array");
	value.mutation.allowedPaths.forEach((entry, index) => assertSafeRelativePath(entry, `mutation.allowedPaths[${index}]`));
	if (!Array.isArray(value.mutation.allowedGitOperations) || value.mutation.allowedGitOperations.length === 0 || value.mutation.allowedGitOperations.some((operation) => !gitOperations.has(String(operation)))) throw new Error("mutation.allowedGitOperations is invalid");
	if (value.mutation.preservePaths !== undefined) {
		if (!Array.isArray(value.mutation.preservePaths)) throw new Error("mutation.preservePaths must be an array");
		value.mutation.preservePaths.forEach((entry, index) => assertSafeRelativePath(entry, `mutation.preservePaths[${index}]`));
	}
	if (!isObject(value.controls)) throw new Error("controls must be an object");
	assertStringArray(value.controls.focused, "controls.focused");
	assertStringArray(value.controls.behavior, "controls.behavior");
	if (!isObject(value.artifact)) throw new Error("artifact must be an object");
	assertSafeRelativePath(value.artifact.filename, "artifact.filename");
	if (!Array.isArray(value.artifact.verdicts) || value.artifact.verdicts.length === 0) throw new Error("artifact.verdicts is required");
	assertStringArray(value.artifact.headings, "artifact.headings");
	assertStringArray(value.artifact.requiredEvidence, "artifact.requiredEvidence");
	if (!isObject(value.artifact.expectedEvidence) || Object.keys(value.artifact.expectedEvidence).length === 0 || !isJsonValue(value.artifact.expectedEvidence)) throw new Error("artifact.expectedEvidence must be a non-empty JSON object");
	if (!isObject(value.remote) || !["none", "local-only"].includes(String(value.remote.policy)) || typeof value.remote.prStub !== "boolean") throw new Error("remote policy is invalid");
	if (value.remote.url !== undefined) {
		assertString(value.remote.url, "remote.url");
		if (value.remote.policy !== "local-only" || !/^(file:\/\/|\.\.?\/|[^:/]+$)/.test(value.remote.url)) throw new Error("real remote URLs are forbidden");
	}
	if (!isObject(value.environment) || value.environment.inherit !== false || !Array.isArray(value.environment.allow)) throw new Error("environment must disable unrestricted inheritance");
	for (const name of value.environment.allow) {
		if (typeof name !== "string" || !safeEnv.test(name)) throw new Error(`environment allowlist entry is unsafe: ${String(name)}`);
	}
	if (!Array.isArray(value.scorers) || value.scorers.length === 0 || value.scorers.some((name) => !scorerNames.has(String(name)))) throw new Error("scorers are missing or unknown");
	assertStringArray(value.criticalFailures, "criticalFailures");
	return value as unknown as ScenarioRecord;
}

export function validateResult(value: unknown): NormalizedResult {
	if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION || value.promptfooVersion !== PROMPTFOO_VERSION) throw new Error("unsupported result contract version");
	assertExactKeys(value, "result", [
		"schemaVersion", "promptfooVersion", "candidateCommit", "fixtureHash", "scenarioId", "role", "candidate", "comparisonMode", "repetition",
		"outer", "startedAt", "finishedAt", "timedOut", "completion", "scorers", "status", "diagnostics", "redactionPassed", "rawEvidencePath",
	], ["child", "artifactPath", "harness"]);
	if (typeof value.candidateCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.candidateCommit)) throw new Error("candidateCommit must be a lowercase Git commit hash");
	if (typeof value.fixtureHash !== "string" || !/^[a-f0-9]{64}$/.test(value.fixtureHash)) throw new Error("fixtureHash must be a lowercase SHA-256");
	assertString(value.scenarioId, "scenarioId");
	if (!safeId.test(value.scenarioId)) throw new Error("scenarioId must use the stable XXX-00 form");
	if (!(String(value.role) in CANDIDATE_PAIRS)) throw new Error("result role is invalid");
	const pair = CANDIDATE_PAIRS[value.role as Role] as readonly string[];
	if (!pair.includes(String(value.candidate))) throw new Error("result candidate is not valid for role");
	if (!["controlled", "native", "canary"].includes(String(value.comparisonMode))) throw new Error("comparisonMode is invalid");
	if (!Number.isInteger(value.repetition) || Number(value.repetition) < 0) throw new Error("repetition must be a non-negative integer");

	if (!isObject(value.outer)) throw new Error("result outer runtime evidence is invalid");
	assertExactKeys(value.outer, "outer", ["provider", "model"], ["sessionFile", "usage"]);
	assertString(value.outer.provider, "outer.provider");
	assertString(value.outer.model, "outer.model");
	if (value.outer.sessionFile !== undefined) assertString(value.outer.sessionFile, "outer.sessionFile");
	if (value.outer.usage !== undefined) validateUsage(value.outer.usage, "outer.usage");

	if (value.child !== undefined) {
		if (!isObject(value.child)) throw new Error("result child runtime evidence is invalid");
		assertExactKeys(value.child, "child", ["agent", "provider", "model", "thinking", "context", "tools", "cwd", "sessionFile", "metadataFile"], ["usage"]);
		for (const key of ["agent", "provider", "model", "thinking", "context", "cwd", "sessionFile", "metadataFile"] as const) assertString(value.child[key], `child.${key}`);
		assertStringArray(value.child.tools, "child.tools");
		if (value.child.usage !== undefined) validateUsage(value.child.usage, "child.usage");
	}

	assertIsoTimestamp(value.startedAt, "startedAt");
	assertIsoTimestamp(value.finishedAt, "finishedAt");
	if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) throw new Error("finishedAt must not precede startedAt");
	if (typeof value.timedOut !== "boolean") throw new Error("timedOut must be a boolean");
	if (!["completed", "timed_out", "launch_failed", "invalid_artifact"].includes(String(value.completion))) throw new Error("completion is invalid");
	if (value.timedOut !== (value.completion === "timed_out")) throw new Error("timedOut and completion are inconsistent");
	if (value.artifactPath !== undefined) assertString(value.artifactPath, "artifactPath");

	if (!Array.isArray(value.scorers) || value.scorers.length !== scorerNames.size) throw new Error("result scorers must contain the complete scorer set");
	const seenScorers = new Set<string>();
	for (const [index, entry] of value.scorers.entries()) {
		if (!isObject(entry)) throw new Error(`scorers[${index}] must be an object`);
		assertExactKeys(entry, `scorers[${index}]`, ["name", "passed", "critical", "detail"], ["available"]);
		if (!scorerNames.has(String(entry.name)) || seenScorers.has(String(entry.name))) throw new Error(`scorers[${index}].name is unknown or duplicated`);
		seenScorers.add(String(entry.name));
		if (typeof entry.passed !== "boolean" || typeof entry.critical !== "boolean") throw new Error(`scorers[${index}] pass/critical flags are invalid`);
		if (entry.critical !== (entry.name !== "usage")) throw new Error(`scorers[${index}].critical does not match the scorer contract`);
		assertString(entry.detail, `scorers[${index}].detail`);
		if (entry.available !== undefined && typeof entry.available !== "boolean") throw new Error(`scorers[${index}].available must be a boolean`);
	}
	if (!["PASS", "CANDIDATE_FAILURE", "INFRASTRUCTURE_FAILURE"].includes(String(value.status))) throw new Error("result status is invalid");
	const criticalFailed = value.scorers.some((entry) => isObject(entry) && entry.critical === true && entry.passed === false);
	if (value.completion === "completed" && (!value.child || value.artifactPath === undefined)) throw new Error("completed results require child and artifact evidence");
	if (value.status === "PASS" && (value.completion !== "completed" || criticalFailed || value.redactionPassed !== true)) throw new Error("PASS is inconsistent with completion, scorers, or redaction");
	if (value.status === "CANDIDATE_FAILURE" && !criticalFailed) throw new Error("CANDIDATE_FAILURE requires a failed critical scorer");
	if (value.status === "INFRASTRUCTURE_FAILURE" && value.scorers.some((entry) => isObject(entry) && entry.critical === true && entry.passed === true)) throw new Error("INFRASTRUCTURE_FAILURE cannot retain candidate scorer passes");
	assertStringArray(value.diagnostics, "diagnostics", true);
	if (typeof value.redactionPassed !== "boolean") throw new Error("result redaction status is required");
	assertString(value.rawEvidencePath, "rawEvidencePath");
	if (value.harness !== undefined) {
		if (!isObject(value.harness)) throw new Error("result harness outcome is invalid");
		assertExactKeys(value.harness, "harness", ["classification", "maxAttempts", "finalAttempt", "attempts"]);
		if (!["scored", "infrastructure_exhausted"].includes(String(value.harness.classification))) throw new Error("harness.classification is invalid");
		if (!Number.isInteger(value.harness.maxAttempts) || Number(value.harness.maxAttempts) < 1 || Number(value.harness.maxAttempts) > 5) throw new Error("harness.maxAttempts must be between 1 and 5");
		if (!Number.isInteger(value.harness.finalAttempt) || Number(value.harness.finalAttempt) < 1 || Number(value.harness.finalAttempt) > Number(value.harness.maxAttempts)) throw new Error("harness.finalAttempt is invalid");
		if (!Array.isArray(value.harness.attempts) || value.harness.attempts.length !== Number(value.harness.finalAttempt)) throw new Error("harness attempts must be complete through finalAttempt");
		for (const [index, attempt] of value.harness.attempts.entries()) {
			if (!isObject(attempt)) throw new Error(`harness.attempts[${index}] must be an object`);
			assertExactKeys(attempt, `harness.attempts[${index}]`, ["attempt", "status", "completion", "diagnostics", "rawEvidencePath", "outer", "scorers", "redactionPassed"], ["artifactPath", "child"]);
			if (attempt.attempt !== index + 1) throw new Error(`harness.attempts[${index}].attempt is not sequential`);
			if (!["PASS", "CANDIDATE_FAILURE", "INFRASTRUCTURE_FAILURE"].includes(String(attempt.status))) throw new Error(`harness.attempts[${index}].status is invalid`);
			if (!["completed", "timed_out", "launch_failed", "invalid_artifact"].includes(String(attempt.completion))) throw new Error(`harness.attempts[${index}].completion is invalid`);
			assertStringArray(attempt.diagnostics, `harness.attempts[${index}].diagnostics`, true);
			assertString(attempt.rawEvidencePath, `harness.attempts[${index}].rawEvidencePath`);
			if (attempt.artifactPath !== undefined) assertString(attempt.artifactPath, `harness.attempts[${index}].artifactPath`);
			if (!isObject(attempt.outer)) throw new Error(`harness.attempts[${index}].outer is invalid`);
			assertExactKeys(attempt.outer, `harness.attempts[${index}].outer`, ["provider", "model"], ["sessionFile", "usage"]);
			assertString(attempt.outer.provider, `harness.attempts[${index}].outer.provider`);
			assertString(attempt.outer.model, `harness.attempts[${index}].outer.model`);
			if (attempt.outer.sessionFile !== undefined) assertString(attempt.outer.sessionFile, `harness.attempts[${index}].outer.sessionFile`);
			if (attempt.outer.usage !== undefined) validateUsage(attempt.outer.usage, `harness.attempts[${index}].outer.usage`);
			if (attempt.child !== undefined) {
				if (!isObject(attempt.child)) throw new Error(`harness.attempts[${index}].child is invalid`);
				assertExactKeys(attempt.child, `harness.attempts[${index}].child`, ["agent", "provider", "model", "thinking", "context", "tools", "cwd", "sessionFile", "metadataFile"], ["usage"]);
				for (const key of ["agent", "provider", "model", "thinking", "context", "cwd", "sessionFile", "metadataFile"] as const) assertString(attempt.child[key], `harness.attempts[${index}].child.${key}`);
				assertStringArray(attempt.child.tools, `harness.attempts[${index}].child.tools`);
				if (attempt.child.usage !== undefined) validateUsage(attempt.child.usage, `harness.attempts[${index}].child.usage`);
			}
			if (!Array.isArray(attempt.scorers) || attempt.scorers.length !== scorerNames.size) throw new Error(`harness.attempts[${index}].scorers is incomplete`);
			const attemptScorers = new Set<string>();
			for (const [scorerIndex, scorer] of attempt.scorers.entries()) {
				if (!isObject(scorer)) throw new Error(`harness.attempts[${index}].scorers[${scorerIndex}] must be an object`);
				assertExactKeys(scorer, `harness.attempts[${index}].scorers[${scorerIndex}]`, ["name", "passed", "critical", "detail"], ["available"]);
				if (!scorerNames.has(String(scorer.name)) || attemptScorers.has(String(scorer.name))) throw new Error(`harness.attempts[${index}].scorers[${scorerIndex}].name is unknown or duplicated`);
				attemptScorers.add(String(scorer.name));
				if (typeof scorer.passed !== "boolean" || typeof scorer.critical !== "boolean") throw new Error(`harness.attempts[${index}].scorers[${scorerIndex}] flags are invalid`);
				if (scorer.critical !== (scorer.name !== "usage")) throw new Error(`harness.attempts[${index}].scorers[${scorerIndex}].critical is invalid`);
				assertString(scorer.detail, `harness.attempts[${index}].scorers[${scorerIndex}].detail`);
				if (scorer.available !== undefined && typeof scorer.available !== "boolean") throw new Error(`harness.attempts[${index}].scorers[${scorerIndex}].available is invalid`);
			}
			if (typeof attempt.redactionPassed !== "boolean") throw new Error(`harness.attempts[${index}].redactionPassed is invalid`);
		}
		const finalAttempt = value.harness.attempts[value.harness.attempts.length - 1];
		if (finalAttempt.status !== value.status) throw new Error("harness final attempt does not match result status");
		if (value.harness.classification === "infrastructure_exhausted") {
			if (value.status !== "INFRASTRUCTURE_FAILURE" || value.harness.finalAttempt !== value.harness.maxAttempts || value.harness.attempts.some((attempt) => isObject(attempt) && attempt.status !== "INFRASTRUCTURE_FAILURE")) throw new Error("infrastructure_exhausted harness outcome is inconsistent");
		} else if (value.status === "INFRASTRUCTURE_FAILURE") throw new Error("scored harness outcome cannot end in infrastructure failure");
	}
	return value as unknown as NormalizedResult;
}
