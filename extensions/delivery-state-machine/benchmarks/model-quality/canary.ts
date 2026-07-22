import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { EvidenceAdmissionCoordinator, type CoordinatedPublication } from "./admission-coordinator.ts";
import { SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST } from "./admission.ts";
import { assertObservedBinding, bindObservedExecution, capturePrelaunchBinding, exactModelId, observedFamily, observedVersion, type ObservedExecutionBinding } from "./binding.ts";
import { SpendLedger, type SpendUsage } from "./spend.ts";
import { loadRegistry } from "./manifest.ts";
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
	outer: ModelIdentity & { thinking: "low"; context: "fresh" };
	judge: ModelIdentity & { thinking: "high"; context: "fresh" };
	routes: { IMPLEMENT: ["worker"]; VERIFY: ["fresh-verifier"]; REVIEW: ["reviewer", "reviewer"]; CLOSE: ["delegate"]; RETRO: ["delegate"] };
	credentialPolicy: { providers: ["openai-codex"]; forwardedEnvironment: []; source: "pi-managed-auth-only" };
	evidence: { root: string; mode: "0700"; retentionDays: 90; priorSpendUsd: number };
	limits: { totalCostUsd: 100; phaseCostUsd: 2; e2eCostUsd: 8; phaseTimeoutMs: 900000; e2eTimeoutMs: 2700000; totalTimeoutMs: 7200000; infrastructureRetries: 1 };
	rows: Array<{ slotId: string; phase: string; scenarioIds: string[]; judge: boolean }>;
}

function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
function configContent(config: RealCanaryConfig): Omit<RealCanaryConfig, "configHash"> { const { configHash: _, ...content } = config; return content; }

export function loadRealCanary(): { config: RealCanaryConfig; manifest: SparseManifest } {
	const config = readJson<RealCanaryConfig>(CONFIG_FILE);
	if (config.schemaVersion !== 1 || config.id !== "PPE-001-REAL-CANARY" || config.version !== 3) throw new Error("real canary config identity is invalid");
	if (hashObject(configContent(config)) !== config.configHash) throw new Error("real canary config hash mismatch");
	if (JSON.stringify(config.credentialPolicy) !== JSON.stringify({ providers: ["openai-codex"], forwardedEnvironment: [], source: "pi-managed-auth-only" })) throw new Error("real canary credential policy changed");
	if (!path.isAbsolute(config.evidence.root) || config.evidence.root !== "/Users/jason/work/projects/model-quality-evidence/ppe-001" || config.evidence.mode !== "0700" || config.evidence.retentionDays !== 90 || config.evidence.priorSpendUsd !== 17.791287) throw new Error("real canary evidence boundary/prior spend changed");
	if (JSON.stringify(config.limits) !== JSON.stringify({ totalCostUsd: 100, phaseCostUsd: 2, e2eCostUsd: 8, phaseTimeoutMs: 900000, e2eTimeoutMs: 2700000, totalTimeoutMs: 7200000, infrastructureRetries: 1 })) throw new Error("real canary limits changed");
	if (JSON.stringify(config.routes) !== JSON.stringify({ IMPLEMENT: ["worker"], VERIFY: ["fresh-verifier"], REVIEW: ["reviewer", "reviewer"], CLOSE: ["delegate"], RETRO: ["delegate"] })) throw new Error("real canary routes changed");
	assertJudgeIndependence([config.judge], [config.participant, config.outer]);
	const manifest = validateManifest(readJson(MANIFEST_FILE));
	if (manifest.id !== config.id || manifest.version !== config.version || manifest.rows.length !== 6 || manifest.maxCostUsd !== config.limits.totalCostUsd) throw new Error("real canary manifest/config mismatch");
	for (const row of manifest.rows) {
		if (row.datasetClass !== "bootstrap" || row.qualificationEligible || row.candidate.provider !== config.participant.provider || row.candidate.model !== config.participant.model || row.candidate.version !== config.participant.version || row.candidate.family !== config.participant.family || row.candidate.thinking !== config.participant.thinking || row.candidate.context !== config.participant.context) throw new Error(`real canary participant mismatch: ${row.slotId}`);
		if (row.maxInfrastructureAttempts !== config.limits.infrastructureRetries + 1 || row.budgetUsd !== (row.phase === "E2E" ? config.limits.e2eCostUsd : config.limits.phaseCostUsd)) throw new Error(`real canary limit mismatch: ${row.slotId}`);
		const expectedAssets = expectedRowAssetBinding(row, config); if (row.candidate.promptVersion !== expectedAssets.promptVersion || row.candidate.toolsHash !== expectedAssets.toolsHash) throw new Error(`real canary prelaunch prompt/tools contract mismatch: ${row.slotId}`);
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

async function withOuterThinking<T>(thinking: string, run: () => Promise<T>): Promise<T> {
	const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppe-001-pi-wrapper-")); const wrapper = path.join(wrapperRoot, "pi");
	const realPi = process.env.PI_BIN ?? "pi"; const quoted = `'${realPi.replace(/'/g, `'"'"'`)}'`;
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quoted} --thinking '${thinking}' "$@"\n`, { mode: 0o700 });
	const prior = process.env.PI_BIN; process.env.PI_BIN = wrapper;
	try { return await run(); }
	finally { if (prior === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = prior; fs.rmSync(wrapperRoot, { recursive: true, force: true }); }
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

export function observeJudgeLaunch(judgeArgs: string[], modelEvent?: { provider?: string; modelId?: string }): { provider: string; model: string; version: string; family: string; thinking: string; context: "fresh" } {
	const thinkingIndex = judgeArgs.indexOf("--thinking"), modelIndex = judgeArgs.indexOf("--model");
	if (thinkingIndex < 0 || modelIndex < 0) throw new Error("sealed judge launch argv is incomplete");
	const [provider, ...modelParts] = judgeArgs[modelIndex + 1].split("/"); const model = modelParts.join("/"); const thinking = judgeArgs[thinkingIndex + 1];
	if (!provider || !model || !thinking) throw new Error("sealed judge launch argv is incomplete");
	if (modelEvent && (modelEvent.provider !== provider || exactModelId(String(modelEvent.modelId)) !== model)) throw new Error("effective judge model event conflicts with sealed launch argv");
	return { provider, model, version: observedVersion(model), family: observedFamily(model), thinking, context: "fresh" };
}

async function judgePhase(config: RealCanaryConfig, row: ManifestRow, candidateArtifact: string, deadline: number): Promise<{ record: JudgeRecord; usage: UsageRecord; wallTimeMs: number; packHash: string; launchSeal: string; effective: ManifestRow["judge"]; observed: { provider: string; model: string; version: string; family: string; thinking: string; context: "fresh" } }> {
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
		const judgeArgs = ["--print", "--mode", "json", "--no-tools", "--model", `${config.judge.provider}/${config.judge.model}`, "--thinking", config.judge.thinking, prompt];
		const judgeLaunchSeal = hashObject({ args: judgeArgs.slice(0, -1), promptHash: hashObject(prompt), cwd: "<FRESH_PRIVATE_HOME>", context: config.judge.context });
		const judgeStarted = Date.now();
		const execution = await spawnCapture(process.env.PI_BIN ?? "pi", judgeArgs, { cwd: temp, env, timeoutMs: remaining });
		const judgeWallTimeMs = Date.now() - judgeStarted;
		if (execution.timedOut || execution.code !== 0) throw new Error(`judge infrastructure failure: ${execution.timedOut ? "timeout" : `exit ${execution.code}`}: ${execution.stderr.slice(0, 500)}`);
		const entries = jsonLines(execution.stdout); const candidates = textFromEvents(entries);
		let record: JudgeRecord | undefined;
		for (const text of candidates.reverse()) { try { record = parseJudgeResponse(text.trim()); break; } catch {} }
		if (!record) throw new Error("judge returned no strict JSON record");
		if (Date.now() > deadline) throw new Error("judge exceeded the frozen row deadline");
		const modelEvent = entries.find((entry) => entry?.type === "model_change");
		if (!/^[a-f0-9]{64}$/.test(judgeLaunchSeal)) throw new Error("effective judge launch settings are unobservable");
		const thinkingIndex = judgeArgs.indexOf("--thinking"), modelIndex = judgeArgs.indexOf("--model"); if (thinkingIndex < 0 || modelIndex < 0 || judgeArgs[thinkingIndex + 1] !== config.judge.thinking || judgeArgs[modelIndex + 1] !== `${config.judge.provider}/${config.judge.model}`) throw new Error("sealed judge launch argv mismatch");
		const observed = observeJudgeLaunch(judgeArgs, modelEvent);
		const expectedObserved = { provider: config.judge.provider, model: config.judge.model, version: config.judge.version, family: config.judge.family, thinking: config.judge.thinking, context: config.judge.context };
		if (JSON.stringify(observed) !== JSON.stringify(expectedObserved)) throw new Error("effective judge identity/settings mismatch");
		const effective = { provider: observed.provider, model: observed.model, version: observed.version, family: observed.family, rubricVersion: row.judge!.rubricVersion };
		if (hashObject({ effective, packHash: pack.packHash, rubric: row.judge!.rubricVersion }) !== hashObject({ effective: row.judge, packHash: pack.packHash, rubric: row.judge!.rubricVersion })) throw new Error("effective judge/rubric identity mismatch");
		return { record, usage: usageFromEvents(entries), wallTimeMs: judgeWallTimeMs, packHash: pack.packHash, launchSeal: judgeLaunchSeal, effective, observed };
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
function connectedScenario(base: ScenarioRecord, phase: string, config: RealCanaryConfig, candidate: string, taskId: string, prior?: { phase: string; hash: string; relativePath: string }): ScenarioRecord {
	const scenario = controlledScenario(phase, config, config.limits.e2eTimeoutMs, candidate);
	const inbound = prior ? `Inbound handoff from ${prior.phase}: read ${prior.relativePath}, verify exact content sha256:${prior.hash}, and emit exactly this machine-readable line in your artifact: CONSUMED_INBOUND: sha256:${prior.hash} path:${prior.relativePath}` : "No inbound handoff: this is the journey origin; do not emit CONSUMED_INBOUND.";
	scenario.fixture = structuredClone(base.fixture); scenario.task = `${base.task}\n\nConnected delivery task ${taskId}. Operate on the same repository. ${inbound}`;
	scenario.artifact = { ...scenario.artifact, verdicts: ["PASS"] }; scenario.invariants = [...base.invariants, "Preserve the connected delivery task and cite the inbound handoff hash when present."];
	scenario.mutation = phase === "IMPLEMENT" ? structuredClone(base.mutation) : { allowedPaths: phase === "CLOSE" ? ["**"] : [], allowedGitOperations: phase === "CLOSE" ? ["stage", "commit", "push", "create-pr-stub"] : ["none"] };
	return scenario;
}
export function expectedRowAssetBinding(row: ManifestRow, config: RealCanaryConfig): { promptVersion: string; toolsHash: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppe-001-binding-preflight-"));
	try {
		const phases = row.phase === "E2E" ? ["IMPLEMENT", "VERIFY", "REVIEW", "REVIEW", "CLOSE", "RETRO"] : row.phase === "REVIEW" ? ["REVIEW", "REVIEW"] : [row.phase];
		const base = controlledScenario("IMPLEMENT", config, 1000, "worker"); const contracts: string[] = [], tools: string[][] = []; let prior: { phase: string; hash: string; relativePath: string } | undefined;
		for (let index = 0; index < phases.length; index++) {
			const phase = phases[index], candidate = phase === "VERIFY" ? "reviewer" : ROUTE_AGENT[phase]; const scenario = row.phase === "E2E" ? connectedScenario(base, phase, config, candidate, "PPE-001-E2E-CONNECTED-v3", prior) : controlledScenario(phase, config, 1000, candidate);
			const artifactPath = path.join(root, `.delivery-evidence/${index + 1}-${phase.toLowerCase()}.md`); const fakeRun = { root, workspace: path.join(root, "workspace"), agentHome: path.join(root, "home"), artifactPath, rawEvidence: path.join(root, "raw"), env: { TMPDIR: path.join(root, "tmp") } } as unknown as ProvisionedRun;
			contracts.push(capturePrelaunchBinding(scenario, fakeRun, config.routes, config.outer).promptContractHash); tools.push([...scenario.launch.tools]); prior = { phase, hash: HASH_PLACEHOLDER, relativePath: `.delivery-evidence/${index + 1}-${phase.toLowerCase()}.md` };
			if (phase === "REVIEW" && phases[index - 1] === "REVIEW") prior = { phase: "REVIEW", hash: HASH_PLACEHOLDER, relativePath: ".delivery-evidence/review-joined.md" };
		}
		return { promptVersion: `sha256:${hashObject(contracts)}`, toolsHash: hashObject(tools) };
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const HASH_PLACEHOLDER = "0".repeat(64);
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
	let observedBinding: ObservedExecutionBinding | undefined;
	const result = await runPromptfooTrial({ scenario, candidate: legacyCandidate, repetition: 0, comparisonMode: "canary", retain: true, executor: async (candidateScenario, _candidate, run) => {
		const prelaunch = capturePrelaunchBinding(candidateScenario, run, config.routes, config.outer);
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
		try {
			const runtime = await withOuterThinking(config.outer.thinking, () => executePiRuntime(candidateScenario, actualAgent, run));
			const provisional = { outer: runtime.outer, child: runtime.child } as NormalizedResult;
			observedBinding = bindObservedExecution(prelaunch, provisional);
			return runtime;
		} finally { if (prior === undefined) delete process.env.PI_SUBAGENTS_ROOT; else process.env.PI_SUBAGENTS_ROOT = prior; fs.rmSync(shim, { recursive: true, force: true }); }
	} }, maxAttempts);
	assertRuntimeIdentity(result, phase, config);
	if (!observedBinding) throw new Error(`${phase} prelaunch/runtime binding was not retained`);
	(result as any).executionBinding = observedBinding;
	return result;
}

export interface HandoffRecord { from: string; to: string; sequence: number; outboundHash: string; outboundRef: string; inboundHash: string; consumedInboundHash: string; consumedInboundRef: string; consumptionEvidenceHash: string; taskId: string; repositoryId: string }
export function parseConsumedInbound(artifact: string, expected: { hash: string; relativePath: string; content: string }): { hash: string; ref: string; evidenceHash: string } {
	if (sha256(expected.content) !== expected.hash) throw new Error("inbound file/content hash changed before consumption validation");
	const matches = [...artifact.matchAll(/^CONSUMED_INBOUND:\s+sha256:([a-f0-9]{64})\s+path:(\S+)\s*$/gm)];
	if (matches.length !== 1) throw new Error("receiving artifact must emit exactly one machine-readable CONSUMED_INBOUND record");
	const hash = matches[0][1], ref = matches[0][2];
	if (hash !== expected.hash || ref !== expected.relativePath) throw new Error("receiving artifact consumed a stale, fabricated, or mismatched inbound reference");
	return { hash, ref, evidenceHash: sha256(matches[0][0]) };
}
export function validateConnectedHandoffs(handoffs: HandoffRecord[]): string[] {
	const expected = ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"];
	const observed = handoffs.map((entry) => `${entry.from}->${entry.to}`);
	if (JSON.stringify(observed) !== JSON.stringify(expected) || handoffs.some((entry, index) => entry.sequence !== index + 1 || entry.inboundHash !== entry.outboundHash || entry.consumedInboundHash !== entry.outboundHash || entry.consumedInboundRef !== entry.outboundRef || !/^[a-f0-9]{64}$/.test(entry.consumptionEvidenceHash) || !entry.taskId || !entry.repositoryId) || new Set(handoffs.map((entry) => entry.taskId)).size !== 1 || new Set(handoffs.map((entry) => entry.repositoryId)).size !== 1) throw new Error("connected E2E handoff chain is incomplete, disconnected, unconsumed, or mismatched");
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
	try { return await withOuterThinking(scenario.launch.thinking, () => executePiRuntime(scenario, agent, run)); }
	finally { if (prior === undefined) delete process.env.PI_SUBAGENTS_ROOT; else process.env.PI_SUBAGENTS_ROOT = prior; fs.rmSync(shim, { recursive: true, force: true }); }
}

export function mayRetryConnectedInfrastructure(evidence: { started: boolean; timedOut: boolean }, retriesRemaining: number): boolean { return !evidence.started && !evidence.timedOut && retriesRemaining > 0; }

async function connectedE2E(config: RealCanaryConfig, deadline: number): Promise<ConnectedJourney> {
	const taskId = "PPE-001-E2E-CONNECTED-v3"; const base = controlledScenario("IMPLEMENT", config, Math.max(1000, deadline - Date.now()), "worker");
	const shared = provisionScenario(base); const repositoryId = sha256(`${taskId}:${shared.gitBefore}:${base.fixture.sha256}`);
	const remote = path.join(shared.root, "connected-remote.git"); Bun.spawnSync(["git", "init", "--bare", remote]); Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: shared.workspace });
	fs.appendFileSync(path.join(shared.workspace, ".git", "info", "exclude"), "\n.delivery-evidence/\n");
	const results: NormalizedResult[] = [], artifacts: string[] = [], handoffs: HandoffRecord[] = [];
	let priorOutbound: { phase: string; hash: string; content: string; relativePath: string } | undefined; let sequence = 0; let retriesRemaining = config.limits.infrastructureRetries;
	const phases = ["IMPLEMENT", "VERIFY", "REVIEW", "REVIEW", "CLOSE", "RETRO"];
	try {
		for (let index = 0; index < phases.length; index++) {
			const phase = phases[index]; if (Date.now() >= deadline) throw new Error("connected E2E deadline exhausted");
			const source = scenarioById(SCENARIO[phase]); const actualAgent = ROUTE_AGENT[phase]; const candidate = phase === "VERIFY" ? "reviewer" : actualAgent;
			const scenario = connectedScenario(base, phase, config, candidate, taskId, priorOutbound); scenario.launch.timeoutMs = Math.max(1000, deadline - Date.now());
			const artifactPath = path.join(shared.workspace, ".delivery-evidence", `${index + 1}-${phase.toLowerCase()}.md`); fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
			const failedAttempts: HarnessAttempt[] = []; let runtime!: RuntimeRun; let phaseRun!: ProvisionedRun; let prelaunch!: ReturnType<typeof capturePrelaunchBinding>; let startedAt = ""; let finishedAt = ""; let rawEvidence = "";
			for (let phaseAttempt = 1; ; phaseAttempt++) {
				rawEvidence = path.join(shared.root, "connected-raw", `${index + 1}-${phase.toLowerCase()}-${phaseAttempt}`); fs.mkdirSync(rawEvidence, { recursive: true });
				const phaseHome = path.join(shared.root, "connected-agent-homes", `${index + 1}-${phase.toLowerCase()}-${phaseAttempt}`); const phaseAgentDir = path.join(phaseHome, ".pi", "agent"); const phaseTmp = path.join(phaseHome, "tmp"); fs.mkdirSync(phaseAgentDir, { recursive: true }); fs.mkdirSync(phaseTmp, { recursive: true });
				phaseRun = { ...shared, agentHome: phaseHome, artifactPath, rawEvidence, localRemote: remote, env: { ...shared.env, HOME: phaseHome, PI_CODING_AGENT_DIR: phaseAgentDir, TMPDIR: phaseTmp, PWD: shared.workspace } };
				prelaunch = capturePrelaunchBinding(scenario, phaseRun, config.routes, config.outer);
				startedAt = new Date().toISOString(); runtime = await executeConnectedRuntime(scenario, actualAgent, phaseRun); finishedAt = new Date().toISOString();
				if (runtime.evidence.completed && !runtime.evidence.timedOut && runtime.child && fs.existsSync(artifactPath)) break;
				const diagnostics = [`connected ${phase} runtime did not complete: ${JSON.stringify(runtime.evidence.infrastructureErrors)}`];
				failedAttempts.push({ attempt: phaseAttempt, status: "INFRASTRUCTURE_FAILURE", completion: runtime.evidence.timedOut ? "timed_out" : "launch_failed", diagnostics, rawEvidencePath: rawEvidence, outer: runtime.outer, child: runtime.child, scorers: [], redactionPassed: true });
				if (!mayRetryConnectedInfrastructure(runtime.evidence, retriesRemaining)) throw new Error(`connected ${phase} runtime did not complete with an artifact: ${JSON.stringify({ evidence: runtime.evidence, childUsage: runtime.child?.usage, outerUsage: runtime.outer.usage })}`);
				retriesRemaining -= 1; fs.rmSync(rawEvidence, { recursive: true, force: true }); fs.rmSync(phaseHome, { recursive: true, force: true }); fs.rmSync(artifactPath, { force: true });
			}
			const content = fs.readFileSync(artifactPath, "utf8"); const outboundHash = sha256(content);
			let consumption: ReturnType<typeof parseConsumedInbound> | undefined;
			if (priorOutbound) consumption = parseConsumedInbound(content, { hash: priorOutbound.hash, relativePath: priorOutbound.relativePath, content: priorOutbound.content });
			if (priorOutbound) {
				const from = priorOutbound.phase === "REVIEW" && phase === "REVIEW" ? undefined : priorOutbound.phase;
				if (from) handoffs.push({ from, to: phase, sequence: ++sequence, outboundHash: priorOutbound.hash, outboundRef: priorOutbound.relativePath, inboundHash: priorOutbound.hash, consumedInboundHash: consumption!.hash, consumedInboundRef: consumption!.ref, consumptionEvidenceHash: consumption!.evidenceHash, taskId, repositoryId });
			}
			const result: NormalizedResult = { schemaVersion: SCHEMA_VERSION, promptfooVersion: PROMPTFOO_VERSION, candidateCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path.resolve(ROOT, "../../../..") }).stdout.toString().trim(), fixtureHash: base.fixture.sha256, scenarioId: source.id, role: phase as any, candidate, comparisonMode: "canary", repetition: index, outer: runtime.outer, child: runtime.child, startedAt, finishedAt, timedOut: false, completion: "completed", artifactPath, scorers: [{ name: "runtime", passed: true, critical: true, detail: "connected runtime and authoritative identity observed" }, { name: "artifact", passed: true, critical: true, detail: "hash-linked connected artifact observed" }], status: "PASS", diagnostics: [], redactionPassed: true, rawEvidencePath: rawEvidence };
			result.harness = { classification: "scored", maxAttempts: config.limits.infrastructureRetries + 1, finalAttempt: failedAttempts.length + 1, attempts: [...failedAttempts, { attempt: failedAttempts.length + 1, status: "PASS", completion: "completed", diagnostics: [], rawEvidencePath: rawEvidence, artifactPath, outer: runtime.outer, child: runtime.child, scorers: result.scorers, redactionPassed: true }] };
			(result as any).executionBinding = { ...bindObservedExecution(prelaunch, result), taskId, repositoryId, inboundHash: consumption?.hash ?? null, inboundRef: consumption?.ref ?? null, consumptionEvidenceHash: consumption?.evidenceHash ?? null, outboundHash };
			results.push(result); artifacts.push(content);
			const relativePath = path.relative(shared.workspace, artifactPath);
			if (phase === "REVIEW" && phases[index + 1] === "REVIEW") priorOutbound = { phase: "REVIEW", hash: outboundHash, content, relativePath };
			else if (phase === "REVIEW" && phases[index - 1] === "REVIEW") { const combined = `${artifacts[index - 1]}\n\n${content}`; const joinedPath = path.join(shared.workspace, ".delivery-evidence", "review-joined.md"); fs.writeFileSync(joinedPath, combined); priorOutbound = { phase: "REVIEW", hash: sha256(combined), content: combined, relativePath: path.relative(shared.workspace, joinedPath) }; }
			else priorOutbound = { phase, hash: outboundHash, content, relativePath };
		}
		validateConnectedHandoffs(handoffs);
		return { results, artifacts, handoffs, cleanup: shared.cleanup };
	} catch (error) { if (process.env.MODEL_QUALITY_DEBUG_KEEP !== "1") shared.cleanup(); else console.error(`connected debug root retained: ${shared.root}`); throw error; }
}

function observedRoutes(row: ManifestRow, config: RealCanaryConfig): Record<string, string> {
	const routes = Object.fromEntries(Object.entries(config.routes).filter(([phase]) => row.phase === "E2E" || phase !== row.phase).map(([phase, agents]) => [phase, `${config.participant.provider}/${config.participant.model}@${config.participant.version}:${agents.join("+")}`]));
	if (hashObject(routes) !== hashObject(row.nonTargetRoutes)) throw new Error(`observed non-target route binding mismatch: ${row.slotId}`);
	return routes;
}
export function assertObservedExecutionBinding(result: NormalizedResult, config: Pick<RealCanaryConfig, "participant" | "outer" | "routes">, row: ManifestRow): void {
	if (!result.child || !(result as any).executionBinding) throw new Error("authoritative runtime/provision binding is unavailable");
	const retained = (result as any).executionBinding as ObservedExecutionBinding;
	const binding: ObservedExecutionBinding = { phase: retained.phase, renderedPromptHash: retained.renderedPromptHash, promptContractHash: retained.promptContractHash, expectedToolsHash: retained.expectedToolsHash, fixtureHash: retained.fixtureHash, scorerHash: retained.scorerHash, routesHash: retained.routesHash, outerRequested: retained.outerRequested, sealHash: retained.sealHash, child: retained.child, outer: retained.outer };
	assertObservedBinding(binding, row, { outer: config.outer, routes: config.routes });
	if (binding.fixtureHash !== result.fixtureHash || binding.scorerHash !== hashObject(scenarioById(result.scenarioId).scorers)) throw new Error("fixture/scorer observed binding mismatch");
}
export function observedCandidate(row: ManifestRow, results: NormalizedResult[], config: RealCanaryConfig): ManifestRow["candidate"] {
	if (!results.length || results.some((result) => !result.child || !(result as any).executionBinding)) throw new Error("effective participant identity/assets are unobservable");
	for (const result of results) assertObservedExecutionBinding(result, config, row);
	const bindings = results.map((result) => (result as any).executionBinding as ObservedExecutionBinding);
	const first = bindings[0].child;
	if (bindings.some((binding) => binding.child.provider !== first.provider || binding.child.model !== first.model || binding.child.version !== first.version || binding.child.family !== first.family || binding.child.thinking !== first.thinking || binding.child.context !== first.context)) throw new Error("participant observations differ within one frozen row");
	const toolsHash = hashObject(bindings.map((binding) => binding.child.tools));
	const promptVersion = `sha256:${hashObject(bindings.map((binding) => binding.promptContractHash))}`;
	const agent = row.phase === "E2E" ? "delivery-state-machine" : first.agent;
	const effective = { provider: first.provider, model: first.model, version: first.version, family: first.family, agent, promptVersion, toolsHash, thinking: first.thinking, context: first.context };
	if (hashObject(effective) !== hashObject(row.candidate)) throw new Error(`observed effective identity/assets mismatch: ${row.slotId}`);
	return effective;
}

function slotFromResults(row: ManifestRow, results: NormalizedResult[], evidenceRef: string, config: RealCanaryConfig, admission: NormalizedSlotResult["admission"], handoffs: string[] = [], judge?: { usage: UsageRecord; wallTimeMs: number; effective: ManifestRow["judge"] }): NormalizedSlotResult {
	const telemetry = results.map(aggregateResultUsage);
	const judgeUsage = { inputTokens: Number(judge?.usage.inputTokens ?? 0), outputTokens: Number(judge?.usage.outputTokens ?? 0), cachedTokens: Number(judge?.usage.cacheReadTokens ?? 0) + Number(judge?.usage.cacheWriteTokens ?? 0), costUsd: Number(judge?.usage.costUsd ?? 0), wallTimeMs: Number(judge?.wallTimeMs ?? 0) };
	const cost = telemetry.reduce((sum, entry) => sum + entry.childCost + entry.outerCost, 0) + judgeUsage.costUsd;
	const status = results.every((result) => result.status === "PASS") ? "PASS" : results.some((result) => result.status === "CANDIDATE_FAILURE") ? "CANDIDATE_FAILURE" : "INFRASTRUCTURE_FAILURE";
	const attempts = results.reduce((sum, result) => sum + (result.harness?.finalAttempt ?? 1), 0);
	const infrastructureAttempts = results.reduce((sum, result) => sum + (result.harness?.attempts.filter((attempt) => attempt.status === "INFRASTRUCTURE_FAILURE").length ?? 0), 0);
	const wallTimeMs = results.reduce((sum, result) => sum + Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)), 0) + judgeUsage.wallTimeMs;
	const value: NormalizedSlotResult = {
		slotId: row.slotId, itemId: row.itemId, itemVersion: row.itemVersion, phase: row.phase, datasetClass: "bootstrap", qualificationEligible: false,
		requested: structuredClone(row.candidate), effective: observedCandidate(row, results, config), nonTargetRoutes: observedRoutes(row, config), ...(row.judge ? { judgeIdentity: structuredClone(judge?.effective) } : {}), judgeUsage, admission,
		isolation: { repository: `disposed://repository/${row.slotId}`, piHome: `disposed://pi-home/${row.slotId}`, artifactRoot: `disposed://raw/${row.slotId}`, resultNamespace: `ppe-001:${row.slotId}`, processGroup: `bounded:${row.slotId}`, credentialBoundary: "allowlisted-ephemeral", remotePolicy: row.phase === "CLOSE" || row.phase === "E2E" ? "local-stub" : "none" },
		cleanupPassed: results.every((result) => !fs.existsSync(result.rawEvidencePath)), redactionPassed: results.every((result) => result.redactionPassed), status,
		slotState: status === "PASS" ? (row.judge ? "JUDGED" : "NOT_ELIGIBLE_CANDIDATE") : status === "CANDIDATE_FAILURE" ? "NOT_ELIGIBLE_CANDIDATE" : "INFRASTRUCTURE_EXHAUSTED",
		deterministicPassed: status === "PASS", qualitativeEligible: Boolean(row.judge && status === "PASS"), attempts, infrastructureAttempts,
		inputTokens: telemetry.reduce((sum, entry) => sum + entry.input, 0) + judgeUsage.inputTokens, outputTokens: telemetry.reduce((sum, entry) => sum + entry.output, 0) + judgeUsage.outputTokens, cachedTokens: telemetry.reduce((sum, entry) => sum + entry.cached, 0) + judgeUsage.cachedTokens,
		childCostUsd: telemetry.reduce((sum, entry) => sum + entry.childCost, 0), outerCostUsd: telemetry.reduce((sum, entry) => sum + entry.outerCost, 0) + judgeUsage.costUsd, wallTimeMs,
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
	const reproduced = buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots: report.slots, generatedAt: report.generatedAt, cost: report.cost });
	if (reproduced.reportHash !== report.reportHash || JSON.stringify(reproduced) !== JSON.stringify(report)) throw new Error("real canary report hash/content does not reproduce");
	if ((fs.statSync(config.evidence.root).mode & 0o777) !== 0o700) throw new Error("durable evidence root permissions changed");
	const store = new EvidenceStore(config.evidence.root); const evidence = store.audit();
	const registry = new Map(loadRegistry().items.map((item) => [`${item.id}@${item.version}`, item]));
	const expectedRefs = new Set(report.evidenceRefs); if (expectedRefs.size !== report.evidenceRefs.length) throw new Error("real canary evidence references must be unique");
	for (const row of manifest.rows) {
		const slot = report.slots.find((entry) => entry.slotId === row.slotId)!; const item = registry.get(`${row.itemId}@${row.itemVersion}`); if (!item) throw new Error("audit registry item unavailable");
		const expectedProvenance = [`${config.participant.provider}/${config.participant.model}@${config.participant.version}`, `${config.outer.provider}/${config.outer.model}@${config.outer.version}`, ...(row.judge ? [`${config.judge.provider}/${config.judge.model}@${config.judge.version}`] : [])];
		for (const reference of slot.evidenceRefs) store.getByRef(reference, { schemaVersionRef: "model-quality-real-canary-v3", assetVersions: [`${row.itemId}@${row.itemVersion}`, `manifest:${manifest.manifestHash}`, `config:${config.configHash}`], participantProvenance: expectedProvenance });
		const coordinator = new EvidenceAdmissionCoordinator(path.join(config.evidence.root, "admission-v3", manifest.manifestHash, row.slotId), store, { id: item.id, version: item.version, itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
		const snapshot: any = coordinator.snapshot();
		for (const publication of slot.admission.publications) {
			const retained = snapshot.publications.find((entry: any) => entry.id === publication.id); if (!retained || retained.eligibility !== "eligible" || retained.evidenceHash !== publication.evidenceHash) throw new Error(`admission publication is unavailable/tainted: ${publication.id}`);
			store.getByRef(publication.evidenceRef, { assetVersions: [`manifest:${manifest.manifestHash}`, `config:${config.configHash}`], participantProvenance: expectedProvenance });
		}
	}
	const ledger = new SpendLedger(config.evidence.root, store, config.limits.totalCostUsd, ["PPE-001-I4-SPEND"]); const ledgerAudit = ledger.audit(config.evidence.priorSpendUsd);
	const reportRecords = store.indexes().filter((record) => record.schemaVersionRef === "model-quality-real-canary-report-v3" && record.assetVersions.includes(`manifest:${manifest.manifestHash}`) && record.assetVersions.includes(`config:${config.configHash}`) && record.assetVersions.includes(`ledger:${ledgerAudit.stateHash}`));
	if (reportRecords.length !== 1) throw new Error("real canary requires exactly one report/human/ledger evidence index");
	const retainedReport = JSON.parse(store.get(reportRecords[0]).toString("utf8"));
	if (retainedReport?.report?.reportHash !== report.reportHash || retainedReport?.humanReview?.recordId !== "PPE-001-I4-INDEPENDENT-REVIEW-PENDING" || retainedReport?.humanReview?.decision !== "pending" || retainedReport?.humanReview?.resultHash !== report.reportHash || retainedReport?.configHash !== config.configHash || retainedReport?.manifestHash !== manifest.manifestHash || retainedReport?.spendLedgerRef !== ledgerAudit.retrievalRef || retainedReport?.spendLedgerHash !== ledgerAudit.stateHash || retainedReport?.cumulativeSpendUsd !== ledgerAudit.totalUsd || hashObject(retainedReport?.cost) !== hashObject(report.cost)) throw new Error("pending human/report/provenance/spend evidence is unavailable or mismatched");
	const rawRoot = path.resolve(ROOT, "../agent-quality/artifacts/raw");
	if (fs.existsSync(rawRoot) && fs.readdirSync(rawRoot).length > 0) throw new Error("raw canary artifacts were not cleaned");
	const repository = path.resolve(ROOT, "../../../..");
	const status = Bun.spawnSync(["git", "status", "--porcelain=v1", "--untracked-files=no"], { cwd: repository }).stdout.toString().trim();
	return { reportHash: report.reportHash, evidenceObjects: evidence.objects, evidenceIndexes: evidence.indexes, gitClean: status === "" };
}

function spendRecord(usage: UsageRecord | undefined, participant: string, wallTimeMs: number): SpendUsage {
	return { inputTokens: Number(usage?.inputTokens ?? 0), outputTokens: Number(usage?.outputTokens ?? 0), cachedTokens: Number(usage?.cacheReadTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0), costUsd: Number(usage?.costUsd ?? 0), wallTimeMs, participant };
}
function spendUsageForResult(result: NormalizedResult, participant: string, outer: string): SpendUsage[] {
	const wall = Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt));
	const attempts = result.harness?.attempts;
	if (attempts?.length) return attempts.flatMap((attempt) => [spendRecord(attempt.child?.usage, participant, wall), spendRecord(attempt.outer.usage, outer, 0)]);
	return [spendRecord(result.child?.usage, participant, wall), spendRecord(result.outer.usage, outer, 0)];
}
function emitCostVisibility(ledger: SpendLedger, currentRunIds: readonly string[]): void {
	const cost = ledger.summary(currentRunIds);
	console.error(`[PPE-001 cost] current=$${cost.currentRunUsd.toFixed(6)} imported=$${cost.importedUsd.toFixed(6)} accepted=$${cost.acceptedUsd.toFixed(6)} rejected=$${cost.rejectedUsd.toFixed(6)} cumulative=$${cost.cumulativeUsd.toFixed(6)}/$${cost.ceilingUsd.toFixed(2)} warnings=${cost.triggeredWarningsUsd.join(",") || "none"} next=${cost.nextWarningUsd ?? "none"}`);
}

export async function runRealCanary(mode: "all" | "e2e" = "all"): Promise<InfrastructureReport> {
	if (process.env.MODEL_QUALITY_CANARY !== "1") throw new Error("real canary is fail-closed: MODEL_QUALITY_CANARY=1 is required");
	const { config, manifest } = loadRealCanary();
	if (process.env.MODEL_QUALITY_EVIDENCE_ROOT && process.env.MODEL_QUALITY_EVIDENCE_ROOT !== config.evidence.root) throw new Error("evidence root differs from the approved immutable config");
	fs.mkdirSync(config.evidence.root, { recursive: true, mode: 0o700 }); fs.chmodSync(config.evidence.root, 0o700);
	const store = new EvidenceStore(config.evidence.root); const participantProvenance = [`${config.participant.provider}/${config.participant.model}@${config.participant.version}`, `${config.outer.provider}/${config.outer.model}@${config.outer.version}`];
	const ledger = new SpendLedger(config.evidence.root, store, config.limits.totalCostUsd, ["PPE-001-I4-SPEND"]);
	if (ledger.read().importedSpendUsd === 0 && ledger.read().entries.length === 0) {
		const legacy = fs.existsSync(path.join(config.evidence.root, "spend-ledger.json")) ? readJson<any>(path.join(config.evidence.root, "spend-ledger.json")) : { entries: [] };
		ledger.migrateLegacy(config.evidence.priorSpendUsd, [{ source: "retained-v1/v2 reports and rejected-attempt ledger", minimumUsd: config.evidence.priorSpendUsd, legacyEntries: legacy.entries ?? [] }]);
	}
	const started = Date.now(); const deadline = started + config.limits.totalTimeoutMs; const slots: NormalizedSlotResult[] = []; const currentRunIds: string[] = [];
	const registry = new Map(loadRegistry().items.map((item) => [`${item.id}@${item.version}`, item]));
	const rows = mode === "e2e" ? manifest.rows.filter((row) => row.phase === "E2E") : manifest.rows;
	for (const row of rows) {
		if (Date.now() >= deadline) throw new Error("approved total canary timeout exhausted");
		const item = registry.get(`${row.itemId}@${row.itemVersion}`); if (!item) throw new Error(`registry item unavailable: ${row.itemId}@${row.itemVersion}`);
		const runId = `${config.id}-v${config.version}-${row.slotId}-${Date.now()}-${randomUUID()}`;
		ledger.begin(runId, row.slotId, row.budgetUsd); currentRunIds.push(runId); emitCostVisibility(ledger, currentRunIds);
		const coordinator = new EvidenceAdmissionCoordinator(path.join(config.evidence.root, "admission-v3", manifest.manifestHash, row.slotId), store, { id: item.id, version: item.version, itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
		const selection = coordinator.authorize("selection"), dispatch = coordinator.authorize("dispatch");
		const phases = row.phase === "REVIEW" ? ["REVIEW", "REVIEW"] : [row.phase];
		const rowDeadline = Math.min(deadline, Date.now() + (row.phase === "E2E" ? config.limits.e2eTimeoutMs : config.limits.phaseTimeoutMs));
		let results: NormalizedResult[] = []; let artifacts: string[] = []; let observedHandoffs: HandoffRecord[] = []; let journeyCleanup: (() => void) | undefined; let spendFinished = false;
		try {
			if (row.phase === "E2E") { const journey = await connectedE2E(config, rowDeadline); results = journey.results; artifacts = journey.artifacts; observedHandoffs = journey.handoffs; journeyCleanup = journey.cleanup; }
			else {
				let retriesRemaining = config.limits.infrastructureRetries;
				for (const phase of phases) {
					if (Date.now() >= rowDeadline) throw new Error(`${row.slotId} timeout exhausted`);
					const result = await stage7Run(phase, config, Math.max(1000, Math.min(config.limits.phaseTimeoutMs, rowDeadline - Date.now())), retriesRemaining + 1);
					const consumed = result.harness?.attempts.filter((attempt) => attempt.status === "INFRASTRUCTURE_FAILURE").length ?? 0; retriesRemaining -= consumed;
					if (retriesRemaining < 0) throw new Error(`${row.slotId} exceeded row-wide infrastructure retry budget`);
					results.push(result); artifacts.push(artifact(result)); if (result.status !== "PASS") break;
				}
			}
			for (const result of results) for (const usage of spendUsageForResult(result, `${config.participant.provider}/${config.participant.model}`, `${config.outer.provider}/${config.outer.model}`)) ledger.record(runId, usage);
			let judge: Awaited<ReturnType<typeof judgePhase>> | undefined;
			if (row.judge && results.every((result) => result.status === "PASS")) {
				judge = await judgePhase(config, row, artifacts.join("\n\n---\n\n"), rowDeadline);
				ledger.record(runId, { inputTokens: Number(judge.usage.inputTokens ?? 0), outputTokens: Number(judge.usage.outputTokens ?? 0), cachedTokens: Number(judge.usage.cacheReadTokens ?? 0) + Number(judge.usage.cacheWriteTokens ?? 0), costUsd: Number(judge.usage.costUsd ?? 0), wallTimeMs: judge.wallTimeMs, participant: `${judge.observed.provider}/${judge.observed.model}` });
			}
			if (Date.now() > rowDeadline) throw new Error(`${row.slotId} exceeded the frozen row deadline`);
			const handoffs = row.phase === "E2E" ? validateConnectedHandoffs(observedHandoffs) : [];
			const transient = { row: row.slotId, phase: row.phase, results: results.map((result) => ({ scenarioId: result.scenarioId, status: result.status, completion: result.completion, scorers: result.scorers, executionBinding: (result as any).executionBinding, artifact: artifact(result), diagnostics: result.diagnostics })), handoffs: observedHandoffs, judge: judge ? { record: judge.record, usage: judge.usage, wallTimeMs: judge.wallTimeMs, packHash: judge.packHash, launchSeal: judge.launchSeal, effective: judge.effective, observed: judge.observed } : undefined, rawTranscript: "not retained" };
			const assets = [`${row.itemId}@${row.itemVersion}`, `manifest:${manifest.manifestHash}`, `config:${config.configHash}`]; const provenance = [...participantProvenance, ...(judge ? [`${judge.observed.provider}/${judge.observed.model}@${judge.observed.version}`] : [])]; const retentionUntil = new Date(Date.now() + config.evidence.retentionDays * 86400000).toISOString();
			const publications: CoordinatedPublication[] = [];
			for (const [index, handoff] of observedHandoffs.entries()) publications.push(coordinator.publish({ id: `${runId}:join:${index + 1}`, publicationKind: "join", expectedSequence: dispatch.sequence, value: handoff, schemaVersionRef: "model-quality-real-canary-handoff-v3", assetVersions: assets, participantProvenance: provenance, retentionUntil }));
			const resultUse = coordinator.publish({ id: `${runId}:result-use`, publicationKind: "result-use", expectedSequence: dispatch.sequence, value: transient, schemaVersionRef: "model-quality-real-canary-v3", assetVersions: assets, participantProvenance: provenance, retentionUntil }); publications.push(resultUse);
			const reportPublication = coordinator.publish({ id: `${runId}:report`, publicationKind: "report", expectedSequence: dispatch.sequence, value: { row: row.slotId, transientRef: resultUse.evidenceRef, handoffs }, schemaVersionRef: "model-quality-real-canary-row-report-v3", assetVersions: assets, participantProvenance: provenance, retentionUntil }); publications.push(reportPublication);
			const admission: NormalizedSlotResult["admission"] = { itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash, selectionSequence: selection.sequence, dispatchSequence: dispatch.sequence, publications };
			for (const result of results) disposeRaw(result); journeyCleanup?.(); journeyCleanup = undefined;
			const slot = slotFromResults(row, results, resultUse.evidenceRef, config, admission, handoffs, judge); const rowCost = slot.childCostUsd + slot.outerCostUsd;
			if (rowCost > row.budgetUsd + Number.EPSILON) throw new Error(`${row.slotId} exceeded approved cost ceiling: ${rowCost} > ${row.budgetUsd}`);
			ledger.finish(runId, "settled", "accepted row completed with exact participant/outer/judge telemetry"); spendFinished = true; emitCostVisibility(ledger, currentRunIds);
			slots.push(slot); if (slot.status !== "PASS") throw new Error(`${row.slotId} did not pass: ${slot.status}`);
		} catch (error) {
			for (const result of results) disposeRaw(result); journeyCleanup?.();
			if (!spendFinished) { try { ledger.finish(runId, "failed", error instanceof Error ? error.message : String(error)); emitCostVisibility(ledger, currentRunIds); } catch (ledgerError) { throw new AggregateError([error, ledgerError], "canary and spend-ledger failure"); } }
			throw error;
		}
	}
	const cost = ledger.summary(currentRunIds);
	const report = buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots, cost });
	const human = validateHumanReview({ recordId: "PPE-001-I4-INDEPENDENT-REVIEW-PENDING", itemId: "BOOT-E2E", itemVersion: 1, resultHash: report.reportHash, decision: "pending", reason: "independent VERIFY/REVIEW follows IMPLEMENT", timestamp: report.generatedAt });
	const ledgerAudit = ledger.audit(config.evidence.priorSpendUsd);
	store.put({ value: { report, humanReview: human, configHash: config.configHash, manifestHash: manifest.manifestHash, cost, cumulativeSpendUsd: ledgerAudit.totalUsd, spendLedgerRef: ledgerAudit.retrievalRef, spendLedgerHash: ledgerAudit.stateHash }, schemaVersionRef: "model-quality-real-canary-report-v3", assetVersions: [`manifest:${manifest.manifestHash}`, `config:${config.configHash}`, `ledger:${ledgerAudit.stateHash}`], participantProvenance: ["PPE-001-I4", ...participantProvenance], retentionUntil: new Date(Date.now() + config.evidence.retentionDays * 86400000).toISOString(), indexId: `accepted-report:${report.reportHash}` });
	store.audit(); fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`); return report;
}

if (import.meta.main) {
	try { console.log(JSON.stringify(await runRealCanary(process.argv[2] === "e2e" ? "e2e" : "all"), null, 2)); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
