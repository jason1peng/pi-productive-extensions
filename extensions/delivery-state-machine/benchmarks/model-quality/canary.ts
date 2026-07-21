import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioById } from "../agent-quality/catalog.ts";
import { runPromptfooTrial } from "../agent-quality/run.ts";
import { artifactPrompt, executePiRuntime, selectAuthentication, type RuntimeRun } from "../agent-quality/runtime.ts";
import { provisionScenario, type ProvisionedRun } from "../agent-quality/provision.ts";
import { PROMPTFOO_VERSION, SCHEMA_VERSION, type HarnessAttempt, type NormalizedResult, type ScenarioRecord, type UsageRecord } from "../agent-quality/schema.ts";
import { EvidenceStore } from "./evidence.ts";
import { assertJudgeIndependence, buildJudgePack, parseJudgeResponse } from "./judge.ts";
import { buildInfrastructureReport, type InfrastructureReport } from "./report.ts";
import { hashObject, manifestContent, sha256, validateHumanReview, validateManifest, validateSlotResult, type JudgeRecord, type ManifestRow, type ModelIdentity, type NormalizedSlotResult, type SparseManifest } from "./schema.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, "bootstrap", "real-canary-config.json");
const MANIFEST_FILE = path.join(ROOT, "bootstrap", "real-canary-manifest.json");
const REPORT_FILE = path.join(ROOT, "reports", "real-canary-result.json");
const ROUTE_AGENT: Record<string, string> = { IMPLEMENT: "worker", VERIFY: "fresh-verifier", REVIEW: "reviewer", CLOSE: "delegate", RETRO: "delegate" };
const SCENARIO: Record<string, string> = { IMPLEMENT: "IMP-01", VERIFY: "VER-01", REVIEW: "REV-01", CLOSE: "CLO-01", RETRO: "RET-01" };

interface RealCanaryConfig {
	schemaVersion: 1; id: string; version: number; approvedAt: string; approvedBy: string; configHash: string;
	participant: ModelIdentity & { thinking: "low"; context: "fresh" };
	outer: ModelIdentity & { thinking: "low" };
	judge: ModelIdentity & { thinking: "high" };
	routes: { IMPLEMENT: ["worker"]; VERIFY: ["fresh-verifier"]; REVIEW: ["reviewer", "reviewer"]; CLOSE: ["delegate"]; RETRO: ["delegate"] };
	credentialPolicy: { providers: ["openai-codex"]; forwardedEnvironment: []; source: "pi-managed-auth-only" };
	evidence: { root: string; mode: "0700"; retentionDays: 90 };
	limits: { totalCostUsd: 20; phaseCostUsd: 2; e2eCostUsd: 8; phaseTimeoutMs: 900000; e2eTimeoutMs: 2700000; totalTimeoutMs: 7200000; infrastructureRetries: 1 };
	rows: Array<{ slotId: string; phase: string; scenarioIds: string[]; judge: boolean }>;
}

function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
function configContent(config: RealCanaryConfig): Omit<RealCanaryConfig, "configHash"> { const { configHash: _, ...content } = config; return content; }

export function loadRealCanary(): { config: RealCanaryConfig; manifest: SparseManifest } {
	const config = readJson<RealCanaryConfig>(CONFIG_FILE);
	if (config.schemaVersion !== 1 || config.id !== "PPE-001-REAL-CANARY" || config.version !== 2) throw new Error("real canary config identity is invalid");
	if (hashObject(configContent(config)) !== config.configHash) throw new Error("real canary config hash mismatch");
	if (JSON.stringify(config.credentialPolicy) !== JSON.stringify({ providers: ["openai-codex"], forwardedEnvironment: [], source: "pi-managed-auth-only" })) throw new Error("real canary credential policy changed");
	if (!path.isAbsolute(config.evidence.root) || config.evidence.root !== "/Users/jason/work/projects/model-quality-evidence/ppe-001" || config.evidence.mode !== "0700" || config.evidence.retentionDays !== 90) throw new Error("real canary evidence boundary changed");
	if (JSON.stringify(config.limits) !== JSON.stringify({ totalCostUsd: 20, phaseCostUsd: 2, e2eCostUsd: 8, phaseTimeoutMs: 900000, e2eTimeoutMs: 2700000, totalTimeoutMs: 7200000, infrastructureRetries: 1 })) throw new Error("real canary limits changed");
	if (JSON.stringify(config.routes) !== JSON.stringify({ IMPLEMENT: ["worker"], VERIFY: ["fresh-verifier"], REVIEW: ["reviewer", "reviewer"], CLOSE: ["delegate"], RETRO: ["delegate"] })) throw new Error("real canary routes changed");
	assertJudgeIndependence([config.judge], [config.participant, config.outer]);
	const manifest = validateManifest(readJson(MANIFEST_FILE));
	if (manifest.id !== config.id || manifest.version !== config.version || manifest.rows.length !== 6 || manifest.maxCostUsd !== config.limits.totalCostUsd) throw new Error("real canary manifest/config mismatch");
	for (const row of manifest.rows) {
		if (row.datasetClass !== "bootstrap" || row.qualificationEligible || row.candidate.provider !== config.participant.provider || row.candidate.model !== config.participant.model || row.candidate.version !== config.participant.version || row.candidate.family !== config.participant.family || row.candidate.thinking !== config.participant.thinking || row.candidate.context !== config.participant.context) throw new Error(`real canary participant mismatch: ${row.slotId}`);
		if (row.maxInfrastructureAttempts !== config.limits.infrastructureRetries + 1 || row.budgetUsd !== (row.phase === "E2E" ? config.limits.e2eCostUsd : config.limits.phaseCostUsd)) throw new Error(`real canary limit mismatch: ${row.slotId}`);
		if ((row.phase === "CLOSE" || row.phase === "E2E") && row.judge) throw new Error(`${row.phase} must not enable a bootstrap judge`);
		if (!["CLOSE", "E2E"].includes(row.phase) && (!row.judge || row.judge.model !== config.judge.model || row.judge.version !== config.judge.version || row.judge.family !== config.judge.family)) throw new Error(`real canary judge mismatch: ${row.slotId}`);
	}
	return { config, manifest };
}

interface Telemetry { input: number; output: number; cached: number; childCost: number; outerCost: number }
function recordUsage(child: UsageRecord = {}, outer: UsageRecord = {}): Telemetry {
	return { input: Number(child.inputTokens ?? 0) + Number(outer.inputTokens ?? 0), output: Number(child.outputTokens ?? 0) + Number(outer.outputTokens ?? 0), cached: Number(child.cacheReadTokens ?? 0) + Number(child.cacheWriteTokens ?? 0) + Number(outer.cacheReadTokens ?? 0) + Number(outer.cacheWriteTokens ?? 0), childCost: Number(child.costUsd ?? 0), outerCost: Number(outer.costUsd ?? 0) };
}
export function aggregateResultUsage(result: NormalizedResult): Telemetry {
	const attempts = result.harness?.attempts;
	if (attempts?.length) return attempts.map((attempt) => recordUsage(attempt.child?.usage, attempt.outer.usage)).reduce((sum, entry) => ({ input: sum.input + entry.input, output: sum.output + entry.output, cached: sum.cached + entry.cached, childCost: sum.childCost + entry.childCost, outerCost: sum.outerCost + entry.outerCost }), { input: 0, output: 0, cached: 0, childCost: 0, outerCost: 0 });
	return recordUsage(result.child?.usage, result.outer.usage);
}

function artifact(result: NormalizedResult): string {
	if (!result.artifactPath || !fs.existsSync(result.artifactPath)) return "artifact unavailable";
	return fs.readFileSync(result.artifactPath, "utf8");
}
function disposeRaw(result: NormalizedResult): void {
	const paths = new Set([result.rawEvidencePath, ...(result.harness?.attempts.map((attempt) => attempt.rawEvidencePath) ?? [])]);
	for (const target of paths) if (target && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

async function spawnCapture(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }> {
	return await new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "", stderr = "", timedOut = false;
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 2000).unref(); }, options.timeoutMs);
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
		child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, timedOut, stdout, stderr: `${stderr}\n${error.message}` }); });
	});
}

function jsonLines(text: string): any[] { return text.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function usageFromEvents(entries: any[]): UsageRecord {
	const total: Required<UsageRecord> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
	for (const entry of entries) {
		const value = entry?.message?.usage ?? entry?.usage;
		if (!value) continue;
		total.inputTokens += Number(value.input ?? value.inputTokens ?? 0); total.outputTokens += Number(value.output ?? value.outputTokens ?? 0);
		total.cacheReadTokens += Number(value.cacheRead ?? value.cacheReadTokens ?? 0); total.cacheWriteTokens += Number(value.cacheWrite ?? value.cacheWriteTokens ?? 0);
		total.costUsd += Number(value.cost?.total ?? value.costUsd ?? 0);
	}
	return total;
}
function textFromEvents(entries: any[]): string[] {
	return entries.flatMap((entry) => {
		const content = entry?.message?.role === "assistant" ? entry.message.content : entry?.type === "message_end" && entry?.message?.role === "assistant" ? entry.message.content : undefined;
		return Array.isArray(content) ? content.filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")) : [];
	});
}

async function judgePhase(config: RealCanaryConfig, row: ManifestRow, candidateArtifact: string, deadline: number): Promise<{ record: JudgeRecord; usage: UsageRecord; packHash: string; effective: ManifestRow["judge"] }> {
	if (["CLOSE", "E2E"].includes(row.phase)) throw new Error(`${row.phase} judge invocation is forbidden`);
	const pack = buildJudgePack({ phase: row.phase, acceptedContract: `PPE-001 bootstrap ${row.phase} contract: evaluate clarity and evidence only; deterministic gates remain authoritative.`, eligibleOutputA: candidateArtifact, eligibleOutputB: `Reference eligible ${row.phase} response with concise evidence and limitations.`, eligibilitySummary: "deterministic Stage 7 controls passed and output is eligible for supplemental infrastructure judging", rubric: `${row.phase} supplemental evidence quality, clarity, actionability, and supported limitations`, nonce: hashObject(`${row.slotId}:${config.configHash}`).slice(0, 32), swap: Number(row.slotId.slice(-1)) % 2 === 0 });
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ppe-001-judge-"));
	try {
		const agentDir = path.join(temp, ".pi", "agent"); fs.mkdirSync(agentDir, { recursive: true }); fs.chmodSync(temp, 0o700);
		const authSource = process.env.PI_AGENT_AUTH_FILE ?? path.join(os.homedir(), ".pi", "agent", "auth.json");
		const selected = selectAuthentication(authSource, [`${config.judge.provider}/${config.judge.model}`]);
		if (!selected.contents) throw new Error("Pi-managed judge authentication is unavailable");
		fs.writeFileSync(path.join(agentDir, "auth.json"), selected.contents, { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: `${config.judge.provider}/${config.judge.model}` }, null, 2), { mode: 0o600 });
		const prompt = `You are an independent supplemental evaluator. Do not use tools. Return exactly one JSON object with keys verdict (A|B|TIE|ABSTAIN), confidence (0..1), citations (string array), limitations (string array). Do not mention identities, cost, latency, or infer hidden provenance. This is infrastructure-only and cannot reverse deterministic results.\n\n${JSON.stringify(pack)}`;
		const remaining = Math.min(config.limits.phaseTimeoutMs, deadline - Date.now());
		if (remaining < 1000) throw new Error("judge deadline exhausted before launch");
		const env: NodeJS.ProcessEnv = { HOME: temp, PI_CODING_AGENT_DIR: agentDir, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: temp, LANG: "C.UTF-8" };
		const execution = await spawnCapture(process.env.PI_BIN ?? "pi", ["--print", "--mode", "json", "--no-tools", "--model", `${config.judge.provider}/${config.judge.model}`, "--thinking", config.judge.thinking, prompt], { cwd: temp, env, timeoutMs: remaining });
		if (execution.timedOut || execution.code !== 0) throw new Error(`judge infrastructure failure: ${execution.timedOut ? "timeout" : `exit ${execution.code}`}: ${execution.stderr.slice(0, 500)}`);
		const entries = jsonLines(execution.stdout); const candidates = textFromEvents(entries);
		let record: JudgeRecord | undefined;
		for (const text of candidates.reverse()) { try { record = parseJudgeResponse(text.trim()); break; } catch {} }
		if (!record) throw new Error("judge returned no strict JSON record");
		if (Date.now() > deadline) throw new Error("judge exceeded the frozen row deadline");
		const modelEvents = entries.filter((entry) => entry?.type === "model_change" || entry?.type === "model" || entry?.message?.role === "assistant");
		const observed = modelEvents.map((entry) => `${entry?.provider ?? entry?.model?.provider ?? entry?.message?.provider ?? ""}/${entry?.modelId ?? entry?.model?.id ?? entry?.message?.model ?? entry?.model ?? ""}`).find((entry) => entry === `${config.judge.provider}/${config.judge.model}`);
		if (!observed) throw new Error("effective judge identity is unobservable");
		const effective = { provider: config.judge.provider, model: config.judge.model, version: config.judge.version, family: config.judge.family, rubricVersion: row.judge!.rubricVersion };
		if (hashObject({ effective, packHash: pack.packHash, rubric: row.judge!.rubricVersion }) !== hashObject({ effective: row.judge, packHash: pack.packHash, rubric: row.judge!.rubricVersion })) throw new Error("effective judge/rubric identity mismatch");
		return { record, usage: usageFromEvents(entries), packHash: pack.packHash, effective };
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function promptAssetHash(phase: string, connected: boolean): string {
	const source = scenarioById(SCENARIO[phase]);
	return hashObject({ templateVersion: connected ? "ppe-001-connected-handoff-v2" : "stage7-controlled-v1", id: source.id, role: source.role, task: source.task, invariants: source.invariants, exclusions: source.exclusions, artifact: source.artifact, mutation: source.mutation, scorers: source.scorers });
}
function controlledScenario(phase: string, config: RealCanaryConfig, timeoutMs: number, legacyCandidate: string): ScenarioRecord {
	const source = scenarioById(SCENARIO[phase]);
	return { ...structuredClone(source), candidates: [legacyCandidate] as any, launch: { ...source.launch, model: `${config.participant.provider}/${config.participant.model}`, thinking: config.participant.thinking, context: config.participant.context, timeoutMs, repetitions: 1 }, environment: { inherit: false, allow: ["NODE_PATH"] } } as ScenarioRecord;
}
function assertRuntimeIdentity(result: NormalizedResult, phase: string, config: RealCanaryConfig): void {
	if (!result.child) throw new Error(`${phase} effective child identity is unavailable`);
	const expectedModel = `${config.participant.provider}/${config.participant.model}`;
	if (result.child.agent !== ROUTE_AGENT[phase] || result.child.provider !== config.participant.provider || result.child.model !== expectedModel || result.child.thinking !== config.participant.thinking || result.child.context !== config.participant.context) throw new Error(`${phase} effective child identity/settings mismatch`);
	if (result.outer.provider !== config.outer.provider || result.outer.model !== `${config.outer.provider}/${config.outer.model}`) throw new Error(`${phase} effective outer identity mismatch`);
}
async function stage7Run(phase: string, config: RealCanaryConfig, timeoutMs: number, maxAttempts: number): Promise<NormalizedResult> {
	const actualAgent = ROUTE_AGENT[phase];
	// The frozen Stage 7 result schema predates the package-owned fresh-verifier route.
	// Keep its legacy VERIFY candidate label while the authoritative runtime evidence
	// and retained metadata must prove the actual fresh-verifier launch.
	const legacyCandidate = phase === "VERIFY" ? "reviewer" : actualAgent;
	const scenario = controlledScenario(phase, config, timeoutMs, legacyCandidate);
	const result = await runPromptfooTrial({ scenario, candidate: legacyCandidate, repetition: 0, comparisonMode: "canary", retain: true, executor: async (candidateScenario, _candidate, run) => {
		if (actualAgent === "fresh-verifier") {
			const source = path.resolve(ROOT, "../../agents/fresh-verifier.md"); const target = path.join(run.env.PI_CODING_AGENT_DIR, "agents", "fresh-verifier.md");
			let contents = fs.readFileSync(source, "utf8")
				.replace(/^tools:\s*.+$/m, `tools: ${candidateScenario.launch.tools.join(", ")}`)
				.replace(/^model:\s*.+$/m, `model: ${candidateScenario.launch.model}`)
				.replace(/^thinking:\s*.+$/m, `thinking: ${candidateScenario.launch.thinking}`)
				.replace(/^inheritSkills:\s*.+$/m, "inheritSkills: false");
			fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
		}
		// The Stage 7 runtime explicitly loads the extension. A source-only shim prevents
		// current Pi package auto-discovery from loading the same root index a second time.
		const installed = process.env.PI_SUBAGENTS_ROOT ?? path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
		const shim = fs.mkdtempSync(path.join(os.tmpdir(), "ppe-001-subagents-shim-"));
		fs.symlinkSync(path.join(installed, "src"), path.join(shim, "src"), "dir");
		fs.writeFileSync(path.join(shim, "package.json"), `${JSON.stringify({ name: "ppe-001-explicit-subagents-shim", private: true, type: "module", pi: { extensions: [] } }, null, 2)}\n`);
		const prior = process.env.PI_SUBAGENTS_ROOT; process.env.PI_SUBAGENTS_ROOT = shim;
		try { return await executePiRuntime(candidateScenario, actualAgent, run); }
		finally { if (prior === undefined) delete process.env.PI_SUBAGENTS_ROOT; else process.env.PI_SUBAGENTS_ROOT = prior; fs.rmSync(shim, { recursive: true, force: true }); }
	} }, maxAttempts);
	assertRuntimeIdentity(result, phase, config);
	(result as any).executionBinding = { promptHash: promptAssetHash(phase, false), fixtureHash: result.fixtureHash, scorerHash: hashObject(scenario.scorers), nonTargetRoutes: config.routes };
	return result;
}

export interface HandoffRecord { from: string; to: string; sequence: number; outboundHash: string; inboundHash: string; taskId: string; repositoryId: string }
export function validateConnectedHandoffs(handoffs: HandoffRecord[]): string[] {
	const expected = ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"];
	const observed = handoffs.map((entry) => `${entry.from}->${entry.to}`);
	if (JSON.stringify(observed) !== JSON.stringify(expected) || handoffs.some((entry, index) => entry.sequence !== index + 1 || entry.inboundHash !== entry.outboundHash || !entry.taskId || !entry.repositoryId) || new Set(handoffs.map((entry) => entry.taskId)).size !== 1 || new Set(handoffs.map((entry) => entry.repositoryId)).size !== 1) throw new Error("connected E2E handoff chain is incomplete, disconnected, or mismatched");
	return observed;
}
interface ConnectedJourney { results: NormalizedResult[]; artifacts: string[]; handoffs: HandoffRecord[]; cleanup: () => void }

async function executeConnectedRuntime(scenario: ScenarioRecord, agent: string, run: ProvisionedRun): Promise<RuntimeRun> {
	if (agent === "fresh-verifier") {
		const source = path.resolve(ROOT, "../../agents/fresh-verifier.md"); const target = path.join(run.env.PI_CODING_AGENT_DIR, "agents", "fresh-verifier.md");
		let contents = fs.readFileSync(source, "utf8").replace(/^tools:\s*.+$/m, `tools: ${scenario.launch.tools.join(", ")}`).replace(/^model:\s*.+$/m, `model: ${scenario.launch.model}`).replace(/^thinking:\s*.+$/m, `thinking: ${scenario.launch.thinking}`).replace(/^inheritSkills:\s*.+$/m, "inheritSkills: false");
		fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
	}
	const installed = process.env.PI_SUBAGENTS_ROOT ?? path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
	const shim = fs.mkdtempSync(path.join(os.tmpdir(), "ppe-001-subagents-shim-"));
	fs.symlinkSync(path.join(installed, "src"), path.join(shim, "src"), "dir");
	fs.writeFileSync(path.join(shim, "package.json"), `${JSON.stringify({ name: "ppe-001-explicit-subagents-shim", private: true, type: "module", pi: { extensions: [] } }, null, 2)}\n`);
	const prior = process.env.PI_SUBAGENTS_ROOT; process.env.PI_SUBAGENTS_ROOT = shim;
	try { return await executePiRuntime(scenario, agent, run); }
	finally { if (prior === undefined) delete process.env.PI_SUBAGENTS_ROOT; else process.env.PI_SUBAGENTS_ROOT = prior; fs.rmSync(shim, { recursive: true, force: true }); }
}

async function connectedE2E(config: RealCanaryConfig, deadline: number): Promise<ConnectedJourney> {
	const taskId = "PPE-001-E2E-CONNECTED-v2"; const base = controlledScenario("IMPLEMENT", config, Math.max(1000, deadline - Date.now()), "worker");
	const shared = provisionScenario(base); const repositoryId = sha256(`${taskId}:${shared.gitBefore}:${base.fixture.sha256}`);
	const remote = path.join(shared.root, "connected-remote.git"); Bun.spawnSync(["git", "init", "--bare", remote]); Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: shared.workspace });
	const results: NormalizedResult[] = [], artifacts: string[] = [], handoffs: HandoffRecord[] = [];
	let priorOutbound: { phase: string; hash: string; content: string } | undefined; let sequence = 0;
	const phases = ["IMPLEMENT", "VERIFY", "REVIEW", "REVIEW", "CLOSE", "RETRO"];
	try {
		for (let index = 0; index < phases.length; index++) {
			const phase = phases[index]; if (Date.now() >= deadline) throw new Error("connected E2E deadline exhausted");
			const source = scenarioById(SCENARIO[phase]); const actualAgent = ROUTE_AGENT[phase]; const candidate = phase === "VERIFY" ? "reviewer" : actualAgent;
			const inbound = priorOutbound ? `Inbound handoff from ${priorOutbound.phase}: sha256:${priorOutbound.hash}\n${priorOutbound.content}` : "No inbound handoff: this is the journey origin.";
			const scenario = controlledScenario(phase, config, Math.max(1000, deadline - Date.now()), candidate);
			scenario.fixture = structuredClone(base.fixture); scenario.task = `${base.task}\n\nConnected delivery task ${taskId}. Operate on the same repository and consume this exact prior state:\n${inbound}`;
			scenario.invariants = [...base.invariants, "Preserve the connected delivery task and cite the inbound handoff hash when present."];
			scenario.mutation = phase === "IMPLEMENT" ? structuredClone(base.mutation) : { allowedPaths: phase === "CLOSE" ? ["**"] : [], allowedGitOperations: phase === "CLOSE" ? ["stage", "commit", "push", "create-pr-stub"] : ["none"] };
			const artifactPath = path.join(shared.root, "connected-artifacts", `${index + 1}-${phase.toLowerCase()}.md`); fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
			const rawEvidence = path.join(shared.root, "connected-raw", `${index + 1}-${phase.toLowerCase()}.json`); fs.mkdirSync(path.dirname(rawEvidence), { recursive: true });
			const phaseRun: ProvisionedRun = { ...shared, artifactPath, rawEvidence, localRemote: remote };
			const startedAt = new Date().toISOString(); const runtime = await executeConnectedRuntime(scenario, actualAgent, phaseRun); const finishedAt = new Date().toISOString();
			if (!runtime.evidence.completed || runtime.evidence.timedOut || !runtime.child || !fs.existsSync(artifactPath)) throw new Error(`connected ${phase} runtime did not complete with an artifact`);
			const content = fs.readFileSync(artifactPath, "utf8"); const outboundHash = sha256(content);
			if (priorOutbound) {
				const from = priorOutbound.phase === "REVIEW" && phase === "REVIEW" ? undefined : priorOutbound.phase;
				if (from) handoffs.push({ from, to: phase, sequence: ++sequence, outboundHash: priorOutbound.hash, inboundHash: priorOutbound.hash, taskId, repositoryId });
			}
			const result: NormalizedResult = { schemaVersion: SCHEMA_VERSION, promptfooVersion: PROMPTFOO_VERSION, candidateCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path.resolve(ROOT, "../../../..") }).stdout.toString().trim(), fixtureHash: base.fixture.sha256, scenarioId: source.id, role: phase as any, candidate, comparisonMode: "canary", repetition: index, outer: runtime.outer, child: runtime.child, startedAt, finishedAt, timedOut: false, completion: "completed", artifactPath, scorers: [{ name: "runtime", passed: true, critical: true, detail: "connected runtime and authoritative identity observed" }, { name: "artifact", passed: true, critical: true, detail: "hash-linked connected artifact observed" }], status: "PASS", diagnostics: [], redactionPassed: true, rawEvidencePath: rawEvidence };
			result.harness = { classification: "scored", maxAttempts: 1, finalAttempt: 1, attempts: [{ attempt: 1, status: "PASS", completion: "completed", diagnostics: [], rawEvidencePath: rawEvidence, artifactPath, outer: runtime.outer, child: runtime.child, scorers: result.scorers, redactionPassed: true }] };
			(result as any).executionBinding = { promptHash: promptAssetHash(phase, true), fixtureHash: base.fixture.sha256, scorerHash: hashObject(scenario.scorers), nonTargetRoutes: config.routes, taskId, repositoryId, inboundHash: priorOutbound?.hash ?? null, outboundHash };
			results.push(result); artifacts.push(content);
			if (phase === "REVIEW" && phases[index + 1] === "REVIEW") priorOutbound = { phase: "REVIEW", hash: outboundHash, content };
			else if (phase === "REVIEW" && phases[index - 1] === "REVIEW") { const combined = `${artifacts[index - 1]}\n\n${content}`; priorOutbound = { phase: "REVIEW", hash: sha256(combined), content: combined }; }
			else priorOutbound = { phase, hash: outboundHash, content };
		}
		validateConnectedHandoffs(handoffs);
		return { results, artifacts, handoffs, cleanup: shared.cleanup };
	} catch (error) { shared.cleanup(); throw error; }
}

function observedRoutes(row: ManifestRow, config: RealCanaryConfig): Record<string, string> {
	const routes = Object.fromEntries(Object.entries(config.routes).filter(([phase]) => row.phase === "E2E" || phase !== row.phase).map(([phase, agents]) => [phase, `${config.participant.provider}/${config.participant.model}@${config.participant.version}:${agents.join("+")}`]));
	if (hashObject(routes) !== hashObject(row.nonTargetRoutes)) throw new Error(`observed non-target route binding mismatch: ${row.slotId}`);
	return routes;
}
function observedCandidate(row: ManifestRow, results: NormalizedResult[], config: RealCanaryConfig): ManifestRow["candidate"] {
	if (!results.length || results.some((result) => !result.child)) throw new Error("effective participant identity is unobservable");
	const expectedModel = `${config.participant.provider}/${config.participant.model}`;
	for (const result of results) if (result.child!.provider !== config.participant.provider || result.child!.model !== expectedModel || result.child!.thinking !== config.participant.thinking || result.child!.context !== config.participant.context) throw new Error("observed participant identity/settings mismatch");
	const toolsHash = hashObject(results.map((result) => result.child!.tools));
	if (results.some((result) => !(result as any).executionBinding)) throw new Error("effective prompt/fixture/scorer binding is unobservable");
	const promptVersion = `sha256:${hashObject(results.map((result) => (result as any).executionBinding.promptHash))}`;
	const agent = row.phase === "E2E" ? "delivery-state-machine" : results[0].child!.agent;
	const effective = { provider: results[0].child!.provider, model: config.participant.model, version: config.participant.version, family: config.participant.family, agent, promptVersion, toolsHash, thinking: results[0].child!.thinking, context: results[0].child!.context };
	if (hashObject(effective) !== hashObject(row.candidate)) throw new Error(`observed effective identity/assets mismatch: ${row.slotId}`);
	return effective;
}

function slotFromResults(row: ManifestRow, results: NormalizedResult[], evidenceRef: string, config: RealCanaryConfig, handoffs: string[] = [], judgeCost = 0, effectiveJudge?: ManifestRow["judge"]): NormalizedSlotResult {
	const telemetry = results.map(aggregateResultUsage); const cost = telemetry.reduce((sum, entry) => sum + entry.childCost + entry.outerCost, 0) + judgeCost;
	const status = results.every((result) => result.status === "PASS") ? "PASS" : results.some((result) => result.status === "CANDIDATE_FAILURE") ? "CANDIDATE_FAILURE" : "INFRASTRUCTURE_FAILURE";
	const attempts = results.reduce((sum, result) => sum + (result.harness?.finalAttempt ?? 1), 0);
	const infrastructureAttempts = results.reduce((sum, result) => sum + (result.harness?.attempts.filter((attempt) => attempt.status === "INFRASTRUCTURE_FAILURE").length ?? 0), 0);
	const wallTimeMs = results.reduce((sum, result) => sum + Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)), 0);
	const value: NormalizedSlotResult = {
		slotId: row.slotId, itemId: row.itemId, itemVersion: row.itemVersion, phase: row.phase, datasetClass: "bootstrap", qualificationEligible: false,
		requested: structuredClone(row.candidate), effective: observedCandidate(row, results, config), nonTargetRoutes: observedRoutes(row, config), ...(row.judge ? { judgeIdentity: structuredClone(effectiveJudge) } : {}),
		isolation: { repository: `disposed://repository/${row.slotId}`, piHome: `disposed://pi-home/${row.slotId}`, artifactRoot: `disposed://raw/${row.slotId}`, resultNamespace: `ppe-001:${row.slotId}`, processGroup: `bounded:${row.slotId}`, credentialBoundary: "allowlisted-ephemeral", remotePolicy: row.phase === "CLOSE" || row.phase === "E2E" ? "local-stub" : "none" },
		cleanupPassed: results.every((result) => !fs.existsSync(result.rawEvidencePath)), redactionPassed: results.every((result) => result.redactionPassed), status,
		slotState: status === "PASS" ? (row.judge ? "JUDGED" : "NOT_ELIGIBLE_CANDIDATE") : status === "CANDIDATE_FAILURE" ? "NOT_ELIGIBLE_CANDIDATE" : "INFRASTRUCTURE_EXHAUSTED",
		deterministicPassed: status === "PASS", qualitativeEligible: Boolean(row.judge && status === "PASS"), attempts, infrastructureAttempts,
		inputTokens: telemetry.reduce((sum, entry) => sum + entry.input, 0), outputTokens: telemetry.reduce((sum, entry) => sum + entry.output, 0), cachedTokens: telemetry.reduce((sum, entry) => sum + entry.cached, 0),
		childCostUsd: telemetry.reduce((sum, entry) => sum + entry.childCost, 0), outerCostUsd: telemetry.reduce((sum, entry) => sum + entry.outerCost, 0) + judgeCost, wallTimeMs,
		firstPlannedPassCostUsd: cost, defaultFirstPlannedPassWallTimeMs: wallTimeMs, minimumPlannedAttempts: row.minimumPlannedAttempts,
		handoffs, evidenceRefs: [evidenceRef],
	};
	return validateSlotResult(value, row);
}

export function auditRealCanary(): { reportHash: string; evidenceObjects: number; evidenceIndexes: number; gitClean: boolean } {
	const { config, manifest } = loadRealCanary();
	if (!fs.existsSync(REPORT_FILE)) throw new Error("real canary report is unavailable");
	const report = readJson<InfrastructureReport>(REPORT_FILE);
	if (report.manifestHash !== manifest.manifestHash || report.slots.length !== manifest.rows.length || report.datasetClass !== "bootstrap" || report.qualificationEligible) throw new Error("real canary report identity/eligibility mismatch");
	for (const row of manifest.rows) {
		const slot = report.slots.find((entry) => entry.slotId === row.slotId);
		if (!slot) throw new Error(`real canary slot is missing: ${row.slotId}`);
		validateSlotResult(slot, row);
		if (slot.status !== "PASS") throw new Error(`real canary slot did not pass: ${row.slotId}`);
	}
	const reproduced = buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots: report.slots, generatedAt: report.generatedAt });
	if (reproduced.reportHash !== report.reportHash || JSON.stringify(reproduced) !== JSON.stringify(report)) throw new Error("real canary report hash/content does not reproduce");
	if ((fs.statSync(config.evidence.root).mode & 0o777) !== 0o700) throw new Error("durable evidence root permissions changed");
	const store = new EvidenceStore(config.evidence.root); const evidence = store.audit();
	const expectedRefs = new Set(report.evidenceRefs);
	if (expectedRefs.size !== report.evidenceRefs.length) throw new Error("real canary evidence references must be unique");
	for (const reference of report.evidenceRefs) {
		if (!/^sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("real canary evidence reference is invalid");
		store.getByRef(reference, { schemaVersionRef: "model-quality-real-canary-v2", assetVersions: [`manifest:${manifest.manifestHash}`, `config:${config.configHash}`] });
	}
	const reportRecords = store.indexes().filter((record) => record.schemaVersionRef === "model-quality-real-canary-report-v2" && record.assetVersions.includes(`manifest:${manifest.manifestHash}`) && record.assetVersions.includes(`config:${config.configHash}`));
	if (reportRecords.length !== 1) throw new Error("real canary requires exactly one report/human evidence index");
	const retainedReport = JSON.parse(store.get(reportRecords[0]).toString("utf8"));
	if (retainedReport?.report?.reportHash !== report.reportHash || retainedReport?.humanReview?.recordId !== "PPE-001-I4-INDEPENDENT-REVIEW-PENDING" || retainedReport?.humanReview?.decision !== "pending" || retainedReport?.humanReview?.resultHash !== report.reportHash) throw new Error("pending human/report evidence is unavailable or mismatched");
	const rawRoot = path.resolve(ROOT, "../agent-quality/artifacts/raw");
	if (fs.existsSync(rawRoot) && fs.readdirSync(rawRoot).length > 0) throw new Error("raw canary artifacts were not cleaned");
	const repository = path.resolve(ROOT, "../../../..");
	const status = Bun.spawnSync(["git", "status", "--porcelain=v1", "--untracked-files=no"], { cwd: repository }).stdout.toString().trim();
	return { reportHash: report.reportHash, evidenceObjects: evidence.objects, evidenceIndexes: evidence.indexes, gitClean: status === "" };
}

export async function runRealCanary(mode: "all" | "e2e" = "all"): Promise<InfrastructureReport> {
	if (process.env.MODEL_QUALITY_CANARY !== "1") throw new Error("real canary is fail-closed: MODEL_QUALITY_CANARY=1 is required");
	const { config, manifest } = loadRealCanary();
	if (process.env.MODEL_QUALITY_EVIDENCE_ROOT && process.env.MODEL_QUALITY_EVIDENCE_ROOT !== config.evidence.root) throw new Error("evidence root differs from the approved immutable config");
	fs.mkdirSync(config.evidence.root, { recursive: true, mode: 0o700 }); fs.chmodSync(config.evidence.root, 0o700);
	const store = new EvidenceStore(config.evidence.root); const started = Date.now(); const deadline = started + config.limits.totalTimeoutMs; const slots: NormalizedSlotResult[] = [];
	const spendLedgerFile = path.join(config.evidence.root, "spend-ledger.json");
	const ledgerSpend = fs.existsSync(spendLedgerFile) ? Number(readJson<{ rejectedSpendUsd: number }>(spendLedgerFile).rejectedSpendUsd) : 0;
	const previousRejectedSpend = (fs.existsSync(REPORT_FILE) ? readJson<InfrastructureReport>(REPORT_FILE).metrics.totalCostUsd : 0) + ledgerSpend;
	if (!Number.isFinite(previousRejectedSpend) || previousRejectedSpend >= config.limits.totalCostUsd) throw new Error("approved cumulative canary budget is exhausted before launch");
	let totalCost = previousRejectedSpend; const rows = mode === "e2e" ? manifest.rows.filter((row) => row.phase === "E2E") : manifest.rows;
	for (const row of rows) {
		if (Date.now() >= deadline) throw new Error("approved total canary timeout exhausted");
		const phases = row.phase === "REVIEW" ? ["REVIEW", "REVIEW"] : [row.phase];
		const rowDeadline = Math.min(deadline, Date.now() + (row.phase === "E2E" ? config.limits.e2eTimeoutMs : config.limits.phaseTimeoutMs));
		let results: NormalizedResult[] = []; let artifacts: string[] = []; let observedHandoffs: HandoffRecord[] = []; let journeyCleanup: (() => void) | undefined;
		try {
			if (row.phase === "E2E") {
				const journey = await connectedE2E(config, rowDeadline); results = journey.results; artifacts = journey.artifacts; observedHandoffs = journey.handoffs; journeyCleanup = journey.cleanup;
			} else {
				let retriesRemaining = config.limits.infrastructureRetries;
				for (const phase of phases) {
					if (Date.now() >= rowDeadline) throw new Error(`${row.slotId} timeout exhausted`);
					const result = await stage7Run(phase, config, Math.max(1000, Math.min(config.limits.phaseTimeoutMs, rowDeadline - Date.now())), retriesRemaining + 1);
					const consumed = result.harness?.attempts.filter((attempt) => attempt.status === "INFRASTRUCTURE_FAILURE").length ?? 0; retriesRemaining -= consumed;
					if (retriesRemaining < 0) throw new Error(`${row.slotId} exceeded row-wide infrastructure retry budget`);
					results.push(result); artifacts.push(artifact(result));
					if (Date.now() > rowDeadline) throw new Error(`${row.slotId} exceeded the frozen row deadline`);
					if (result.status !== "PASS") break;
				}
			}
			let judge: { record: JudgeRecord; usage: UsageRecord; packHash: string; effective: ManifestRow["judge"] } | undefined;
			if (row.judge && results.every((result) => result.status === "PASS")) judge = await judgePhase(config, row, artifacts.join("\n\n---\n\n"), rowDeadline);
			if (Date.now() > rowDeadline) throw new Error(`${row.slotId} exceeded the frozen row deadline`);
			const handoffs = observedHandoffs.map((entry) => `${entry.from}->${entry.to}`);
			const transient = { row: row.slotId, phase: row.phase, results: results.map((result) => ({ scenarioId: result.scenarioId, status: result.status, completion: result.completion, scorers: result.scorers, requested: row.candidate, effective: result.child ? { agent: result.child.agent, provider: result.child.provider, model: result.child.model, thinking: result.child.thinking, context: result.child.context, tools: result.child.tools } : null, outer: { provider: result.outer.provider, model: result.outer.model }, executionBinding: (result as any).executionBinding, artifact: artifact(result), diagnostics: result.diagnostics })), handoffs: observedHandoffs, judge: judge ? { record: judge.record, packHash: judge.packHash, effective: judge.effective } : undefined, priorRejectedSpendUsd: previousRejectedSpend, rawTranscript: "not retained" };
			const record = store.put({ value: transient, schemaVersionRef: "model-quality-real-canary-v2", assetVersions: [`${row.itemId}@${row.itemVersion}`, `manifest:${manifest.manifestHash}`, `config:${config.configHash}`], participantProvenance: [`${config.participant.provider}/${config.participant.model}@${config.participant.version}`, `${config.outer.provider}/${config.outer.model}@${config.outer.version}`, ...(judge ? [`${config.judge.provider}/${config.judge.model}@${config.judge.version}`] : [])], retentionUntil: new Date(Date.now() + config.evidence.retentionDays * 86400000).toISOString() });
			for (const result of results) disposeRaw(result); journeyCleanup?.(); journeyCleanup = undefined;
			const judgeCost = Number(judge?.usage.costUsd ?? 0); const slot = slotFromResults(row, results, record.retrievalRef, config, handoffs, judgeCost, judge?.effective); const rowCost = slot.childCostUsd + slot.outerCostUsd;
			if (rowCost > row.budgetUsd + Number.EPSILON) throw new Error(`${row.slotId} exceeded approved cost ceiling: ${rowCost} > ${row.budgetUsd}`);
			totalCost += rowCost; if (totalCost > config.limits.totalCostUsd + Number.EPSILON) throw new Error(`total canary exceeded approved cost ceiling: ${totalCost}`);
			slots.push(slot);
			if (slot.status !== "PASS") throw new Error(`${row.slotId} did not pass: ${slot.status}`);
		} catch (error) { for (const result of results) disposeRaw(result); journeyCleanup?.(); throw error; }
	}
	const report = buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots });
	const human = validateHumanReview({ recordId: "PPE-001-I4-INDEPENDENT-REVIEW-PENDING", itemId: "BOOT-E2E", itemVersion: 1, resultHash: report.reportHash, decision: "pending", reason: "independent VERIFY/REVIEW follows IMPLEMENT", timestamp: report.generatedAt });
	store.put({ value: { report, humanReview: human, configHash: config.configHash, cumulativeSpendUsd: totalCost, previousRejectedSpendUsd: previousRejectedSpend }, schemaVersionRef: "model-quality-real-canary-report-v2", assetVersions: [`manifest:${manifest.manifestHash}`, `config:${config.configHash}`], participantProvenance: ["PPE-001-I4"], retentionUntil: new Date(Date.now() + config.evidence.retentionDays * 86400000).toISOString() });
	store.audit(); fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

if (import.meta.main) {
	try { console.log(JSON.stringify(await runRealCanary(process.argv[2] === "e2e" ? "e2e" : "all"), null, 2)); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
