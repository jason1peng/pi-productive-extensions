import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioById } from "../../agent-quality/catalog.ts";
import { AdmissionGuard, signSyntheticHumanResolution, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST, type IncidentReport } from "../admission.ts";
import { EvidenceAdmissionCoordinator } from "../admission-coordinator.ts";
import { SpendLedger, spendProcessStart, type SpendLockRecord } from "../spend.ts";
import { aggregateResultUsage, assertFrozenCanaryEnvironment, assertObservedExecutionBinding, loadRealCanary, mayRetryConnectedInfrastructure, observedCandidate, observeJudgeLaunch, parseConsumedInbound, sanitizeConnectedPayload, validateConnectedHandoffs, type HandoffRecord } from "../canary.ts";
import { EvidenceStore, assertRedacted, redactValue } from "../evidence.ts";
import { assertExactSparseSelection, loadBootstrapAssets, loadManifest, loadRegistry, resolveRows } from "../manifest.ts";
import { lifecycleRecord, validateLifecycleTransition } from "../lifecycle.ts";
import { adoptionDecision, buildInfrastructureReport, joinedMetrics } from "../report.ts";
import { boundedOutcome, qualitativeDenominator } from "../outcome.ts";
import { classifyInfrastructure, falseRates, scorePhaseEvidence } from "../scorers/index.ts";
import { assertBootstrapNonQualification, canModelBlockDeterministicPass, hashObject, sha256, manifestContent, validateDatasetItem, validateHumanReview, validateManifest, validateSlotResult, type NormalizedSlotResult, type PhaseEvidence } from "../schema.ts";
import { assertJudgeIndependence, blockerConfirmed, buildJudgePack, parseJudgeResponse } from "../judge.ts";
import { admissionRunnerProbe, auditCleanClone, fakeFull, validateInfrastructure } from "../run.ts";
import { validateStage7Sentinels } from "../stage7.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH_A = hashObject("a");
const HASH_B = hashObject("b");
const HASH_C = hashObject("c");

const validation = validateInfrastructure();
assert.deepEqual(validation, { items: 6, rows: 6, sentinels: 17 });
const registry = loadRegistry();
const manifest = loadManifest();
assert.equal(resolveRows(manifest, registry).length, 6);
assert.equal(loadBootstrapAssets(registry).assets.length, 6);
assert.deepEqual(new Set(manifest.rows.map((row) => row.phase)), new Set(["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO", "E2E"]));
assert.equal(assertExactSparseSelection(manifest, ["BOOT-SLOT-01", "BOOT-SLOT-06"]).length, 2);
assert.throws(() => assertExactSparseSelection(manifest, ["BOOT-SLOT-01", "BOOT-SLOT-01"]), /duplicate/);
assert.throws(() => assertExactSparseSelection(manifest, ["MISSING"]), /exactly/);
assert.equal(validateStage7Sentinels().stage7Commit, "08cfb3d802cbb7cff4993f92105e97616663094c");
const connectedHandoffs: HandoffRecord[] = ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"].map((edge, index) => { const [from, to] = edge.split("->"); return { from, to, sequence: index + 1, outboundHash: HASH_A, outboundRef: ".delivery-evidence/prior.md", inboundHash: HASH_A, consumedInboundHash: HASH_A, consumedInboundRef: ".delivery-evidence/prior.md", consumptionEvidenceHash: HASH_C, taskId: "TASK-1", repositoryId: "REPO-1" }; });
assert.deepEqual(validateConnectedHandoffs(connectedHandoffs), ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"]);
assert.throws(() => validateConnectedHandoffs(connectedHandoffs.slice(0, 3)), /incomplete/);
assert.throws(() => validateConnectedHandoffs(connectedHandoffs.map((entry, index) => index === 1 ? { ...entry, inboundHash: HASH_B } : entry)), /mismatched/);
const inboundContent = "prior artifact"; const inboundHash = sha256(inboundContent); const inboundRef = ".delivery-evidence/prior.md";
assert.deepEqual(parseConsumedInbound(`RESULT: PASS\nCONSUMED_INBOUND: sha256:${inboundHash} path:${inboundRef}\n`, { hash: inboundHash, relativePath: inboundRef, content: inboundContent }).hash, inboundHash);
for (const artifact of ["RESULT: PASS", `CONSUMED_INBOUND: sha256:${HASH_B} path:${inboundRef}`, `CONSUMED_INBOUND: sha256:${inboundHash} path:wrong.md`, `CONSUMED_INBOUND: sha256:${inboundHash} path:${inboundRef}\nCONSUMED_INBOUND: sha256:${inboundHash} path:${inboundRef}`]) assert.throws(() => parseConsumedInbound(artifact, { hash: inboundHash, relativePath: inboundRef, content: inboundContent }), /exactly one|stale|fabricated|mismatched/);
assert.throws(() => parseConsumedInbound(`CONSUMED_INBOUND: sha256:${inboundHash} path:${inboundRef}`, { hash: inboundHash, relativePath: inboundRef, content: "changed" }), /content hash/);
assert.throws(() => validateConnectedHandoffs(connectedHandoffs.map((entry, index) => index === 2 ? { ...entry, repositoryId: "REPO-2" } : entry)), /disconnected/);

const realCanary = loadRealCanary();
assert.equal(realCanary.manifest.rows.length, 6);
assert.equal(realCanary.manifest.rows.reduce((sum, row) => sum + row.budgetUsd, 0), 18);
assert.equal(realCanary.config.limits.totalCostUsd, 100);
assert.equal(realCanary.config.evidence.priorSpendUsd, 17.791287);
assert.deepEqual(realCanary.config.credentialPolicy.forwardedEnvironment, []);
assert.deepEqual(realCanary.config.rows.find((row) => row.phase === "REVIEW")?.scenarioIds, ["REV-01", "REV-01"]);
const opaqueConnectedSecret = "OpaqueCredentialValue987654321";
assert.deepEqual(sanitizeConnectedPayload({ artifact: "safe connected artifact" }, [opaqueConnectedSecret]), { artifact: "safe connected artifact" });
assert.throws(() => sanitizeConnectedPayload({ artifact: opaqueConnectedSecret }, [opaqueConnectedSecret]), /credential material|ineligible/);
const priorOuterOverride = process.env.DSM_AGENT_EVAL_OUTER_MODEL; const priorAuthOverride = process.env.PI_AGENT_AUTH_FILE;
try {
	process.env.DSM_AGENT_EVAL_OUTER_MODEL = "anthropic/claude-test";
	assert.throws(() => assertFrozenCanaryEnvironment(realCanary.config), /before launch|conflicts/);
	delete process.env.DSM_AGENT_EVAL_OUTER_MODEL; process.env.PI_AGENT_AUTH_FILE = path.join(os.tmpdir(), "unapproved-auth.json");
	assert.throws(() => assertFrozenCanaryEnvironment(realCanary.config), /credential-file override.*before launch/);
} finally {
	if (priorOuterOverride === undefined) delete process.env.DSM_AGENT_EVAL_OUTER_MODEL; else process.env.DSM_AGENT_EVAL_OUTER_MODEL = priorOuterOverride;
	if (priorAuthOverride === undefined) delete process.env.PI_AGENT_AUTH_FILE; else process.env.PI_AGENT_AUTH_FILE = priorAuthOverride;
}
assert.doesNotThrow(() => assertFrozenCanaryEnvironment(realCanary.config));
const sealedJudgeArgs = ["--model", "openai-codex/gpt-5.5", "--thinking", "high"];
assert.deepEqual(observeJudgeLaunch(sealedJudgeArgs), { provider: "openai-codex", model: "gpt-5.5", version: "gpt-5.5", family: "gpt-5.5", thinking: "high", context: "fresh" });
assert.doesNotThrow(() => observeJudgeLaunch(sealedJudgeArgs, { provider: "openai-codex", modelId: "gpt-5.5" }));
assert.throws(() => observeJudgeLaunch(sealedJudgeArgs, { provider: "openai-codex", modelId: "gpt-5.6-sol" }), /conflicts/);
assert.equal(mayRetryConnectedInfrastructure({ started: false, timedOut: false }, 1), true);
assert.equal(mayRetryConnectedInfrastructure({ started: true, timedOut: false }, 1), false);
assert.equal(mayRetryConnectedInfrastructure({ started: false, timedOut: true }, 1), false);
assert.equal(mayRetryConnectedInfrastructure({ started: false, timedOut: false }, 0), false);
assert.equal(realCanary.manifest.rows.find((row) => row.phase === "CLOSE")?.judge, undefined);
assert.equal(realCanary.manifest.rows.find((row) => row.phase === "E2E")?.judge, undefined);
const observedTools = ["read", "grep", "find", "ls", "bash"];
const prelaunchBody: any = { phase: "IMPLEMENT", renderedPromptHash: HASH_A, promptContractHash: HASH_B, expectedToolsHash: hashObject(observedTools), fixtureHash: "fixture-v1", scorerHash: hashObject(scenarioById("IMP-01").scorers), routesHash: hashObject(realCanary.config.routes), outerRequested: { provider: "openai-codex", model: "gpt-5.6-sol", version: "gpt-5.6-sol", family: "gpt-5.6", thinking: "low", context: "fresh" } };
const binding: any = { ...prelaunchBody, sealHash: hashObject(prelaunchBody), child: { agent: "worker", provider: "openai-codex", model: "gpt-5.6-sol", version: "gpt-5.6-sol", family: "gpt-5.6", thinking: "low", context: "fresh", tools: observedTools, toolsHash: hashObject(observedTools) }, outer: structuredClone(prelaunchBody.outerRequested) };
const syntheticObservedRow: any = structuredClone(realCanary.manifest.rows[0]); syntheticObservedRow.candidate.promptVersion = `sha256:${hashObject([binding.promptContractHash])}`; syntheticObservedRow.candidate.toolsHash = hashObject([observedTools]);
const observedRuntime: any = { scenarioId: "IMP-01", fixtureHash: "fixture-v1", child: { agent: "worker", provider: "openai-codex", model: "openai-codex/gpt-5.6-sol", thinking: "low", context: "fresh", tools: observedTools, usage: {} }, outer: { provider: "openai-codex", model: "openai-codex/gpt-5.6-sol", usage: {} }, executionBinding: { ...binding, taskId: "connected", repositoryId: "repository", inboundHash: null, outboundHash: HASH_A } };
assert.doesNotThrow(() => assertObservedExecutionBinding(observedRuntime, realCanary.config, syntheticObservedRow));
assert.deepEqual(observedCandidate(syntheticObservedRow, [observedRuntime], realCanary.config), syntheticObservedRow.candidate);
for (const [field, mutate, aggregate] of [
	["participant-version", (value: any) => { value.executionBinding.child.version = "gpt-5.6-other"; }, false],
	["participant-family", (value: any) => { value.executionBinding.child.family = "gpt-5.7"; }, false],
	["thinking", (value: any) => { value.executionBinding.child.thinking = "high"; }, false],
	["context", (value: any) => { value.executionBinding.child.context = "fork"; }, false],
	["outer-version", (value: any) => { value.executionBinding.outer.version = "other"; }, false],
	["outer-family", (value: any) => { value.executionBinding.outer.family = "gpt-5.5"; }, false],
	["outer-thinking", (value: any) => { value.executionBinding.outer.thinking = "high"; }, false],
	["prompt-valid-sha", (value: any) => { value.executionBinding.promptContractHash = HASH_C; const { sealHash: _, child: _c, outer: _o, ...body } = value.executionBinding; value.executionBinding.sealHash = hashObject(body); }, true],
	["tools-valid-sha", (value: any) => { value.executionBinding.child.toolsHash = HASH_C; }, false],
	["fixture", (value: any) => { value.executionBinding.fixtureHash = HASH_C; const { sealHash: _, child: _c, outer: _o, ...body } = value.executionBinding; value.executionBinding.sealHash = hashObject(body); }, false],
	["scorer", (value: any) => { value.executionBinding.scorerHash = HASH_C; const { sealHash: _, child: _c, outer: _o, ...body } = value.executionBinding; value.executionBinding.sealHash = hashObject(body); }, false],
	["routes", (value: any) => { value.executionBinding.routesHash = HASH_C; const { sealHash: _, child: _c, outer: _o, ...body } = value.executionBinding; value.executionBinding.sealHash = hashObject(body); }, false],
] as const) {
	const value = structuredClone(observedRuntime); mutate(value);
	assert.throws(() => aggregate ? observedCandidate(syntheticObservedRow, [value], realCanary.config) : assertObservedExecutionBinding(value, realCanary.config, syntheticObservedRow), /mismatch|unavailable|binding/, `tampered ${field} must fail`);
}

function rehash(value: any): any { value.manifestHash = hashObject(manifestContent(value)); return value; }
function invalidManifest(mutator: (value: any) => void, pattern?: RegExp): void {
	const value = structuredClone(manifest) as any;
	mutator(value);
	rehash(value);
	assert.throws(() => validateManifest(value), pattern);
}
invalidManifest((value) => { value.rows.push(structuredClone(value.rows[0])); value.expectedRows += 1; value.maxRows += 1; }, /duplicate/);
invalidManifest((value) => { value.rows.push({ ...structuredClone(value.rows[0]), slotId: "EXTRA" }); value.expectedRows += 1; }, /frozen bounds/);
invalidManifest((value) => { value.rows[0].budgetUsd = 1; }, /cost ceiling/);
invalidManifest((value) => { value.rows[0].qualificationEligible = true; }, /qualification-ineligible/);
invalidManifest((value) => { value.rows[0].datasetClass = "golden"; }, /cannot be relabeled/);
invalidManifest((value) => { value.rows[3].judge = structuredClone(value.rows[0].judge); }, /CLOSE/);
invalidManifest((value) => { value.rows[0].judge = { ...value.rows[0].judge, provider: "fake", model: "bootstrap-participant", family: "synthetic-participant" }; }, /collision/);
invalidManifest((value) => { value.serial = false; }, /serial/);
{
	const value: any = structuredClone(manifest);
	value.matrix = { candidates: [], scenarios: [] };
	rehash(value);
	assert.throws(() => validateManifest(value), /unknown|Cartesian/);
}
{
	const value: any = structuredClone(manifest);
	value.rows[0].slotId = "MUTATED";
	assert.throws(() => validateManifest(value), /hash/);
}

const bootstrapItem = registry.items[0];
assert.throws(() => validateDatasetItem({ ...bootstrapItem, qualificationEligible: true }), /qualification-ineligible/);
assert.throws(() => validateDatasetItem({ ...bootstrapItem, datasetClass: "golden" }), /cannot be relabeled/);
assert.throws(() => assertBootstrapNonQualification({ datasetClass: "bootstrap", qualificationEligible: true }, "schema"), /forbidden/);
const proposed = lifecycleRecord({ itemId: "BOOT-X", itemVersion: 1, itemHash: HASH_A, priorState: "draft", targetState: "proposed", actorId: "llm-proposer-1", actorRole: "llm-proposer", reason: "new synthetic case", timestamp: "2026-07-21T00:00:00.000Z", idempotencyKey: "proposal-1" });
assert.doesNotThrow(() => validateLifecycleTransition(proposed));
const activated = lifecycleRecord({ itemId: "GOLD-X", itemVersion: 1, itemHash: HASH_A, priorState: "approved", targetState: "active", actorId: "human-1", actorRole: "authorized-human", reason: "approved activation", timestamp: "2026-07-21T00:00:00.000Z", idempotencyKey: "activate-1" });
assert.doesNotThrow(() => validateLifecycleTransition(activated));
const { recordHash: _activatedHash, ...activatedInput } = activated;
const { recordHash: _proposedHash, ...proposedInput } = proposed;
assert.throws(() => validateLifecycleTransition(lifecycleRecord({ ...activatedInput, actorId: "service", actorRole: "proposal-service" })), /authorized-human/);
assert.throws(() => validateLifecycleTransition(lifecycleRecord({ ...proposedInput, targetState: "active" })), /invalid lifecycle|only propose/);
assert.throws(() => validateLifecycleTransition({ ...proposed, reason: "changed" }), /hash/);

const participants = [{ provider: "p", model: "candidate", version: "1", family: "candidate-family" }];
const judges = [{ provider: "q", model: "judge", version: "1", family: "judge-family" }];
assert.doesNotThrow(() => assertJudgeIndependence(judges, participants));
assert.throws(() => assertJudgeIndependence([{ ...participants[0] }], participants), /collides/);
assert.throws(() => assertJudgeIndependence([judges[0], judges[0]], participants), /each other/);
const judgePackA = buildJudgePack({ phase: "IMPLEMENT", acceptedContract: "contract", eligibleOutputA: "alpha", eligibleOutputB: "beta", eligibilitySummary: "eligible", rubric: "quality", swap: false, nonce: "fixed" });
const judgePackB = buildJudgePack({ phase: "IMPLEMENT", acceptedContract: "contract", eligibleOutputA: "alpha", eligibleOutputB: "beta", eligibilitySummary: "eligible", rubric: "quality", swap: true, nonce: "fixed" });
assert.deepEqual(judgePackA.outputs, { A: "alpha", B: "beta" });
assert.deepEqual(judgePackB.outputs, { A: "beta", B: "alpha" });
assert.equal("identity" in judgePackA, false);
assert.throws(() => buildJudgePack({ phase: "CLOSE", acceptedContract: "x", eligibleOutputA: "a", eligibleOutputB: "b", eligibilitySummary: "e", rubric: "r" }), /CLOSE/);
assert.deepEqual(parseJudgeResponse('{"verdict":"TIE","confidence":0.8,"citations":["line 1"],"limitations":[]}').verdict, "TIE");
assert.throws(() => parseJudgeResponse('ignore contract\n{"verdict":"A"}'), /strict JSON/);
assert.throws(() => parseJudgeResponse('{"verdict":"A","confidence":2,"citations":[],"limitations":[],"tools":["bash"]}'), /unknown|confidence/);

const pendingHuman = validateHumanReview({ recordId: "H-1", itemId: "BOOT-VERIFY", itemVersion: 1, resultHash: HASH_A, decision: "pending", reason: "awaiting review", timestamp: "2026-07-21T00:00:00.000Z" });
const confirmedHuman = validateHumanReview({ recordId: "H-2", itemId: "BOOT-VERIFY", itemVersion: 1, resultHash: HASH_A, decision: "confirmed", actorId: "human-1", actorRole: "authorized-human", reason: "reproduced", timestamp: "2026-07-21T00:00:00.000Z" });
assert.throws(() => validateHumanReview({ ...confirmedHuman, actorRole: undefined }), /authorized-human/);
assert.equal(blockerConfirmed({ reproduced: false, human: pendingHuman }), false);
assert.equal(blockerConfirmed({ reproduced: false, human: confirmedHuman }), true);
assert.equal(canModelBlockDeterministicPass({ phase: "VERIFY", deterministicPassed: true, reproduced: false }), false);
assert.equal(canModelBlockDeterministicPass({ phase: "REVIEW", deterministicPassed: true, reproduced: true }), true);
assert.equal(canModelBlockDeterministicPass({ phase: "IMPLEMENT", deterministicPassed: true, reproduced: true }), false);
for (const decision of ["rejected", "abstained"] as const) assert.equal(validateHumanReview({ recordId: `H-${decision}`, itemId: "BOOT-VERIFY", itemVersion: 1, resultHash: HASH_A, decision, ...(decision === "rejected" ? { actorId: "human-2", actorRole: "authorized-human" as const } : {}), reason: decision, timestamp: "2026-07-21T00:00:00.000Z" }).decision, decision);

const attemptTelemetry = aggregateResultUsage({ child: { usage: { inputTokens: 3, costUsd: 0.2 } }, outer: { usage: { outputTokens: 4, costUsd: 0.3 } }, harness: { attempts: [{ child: { usage: { inputTokens: 10, costUsd: 0.7 } }, outer: { usage: { outputTokens: 11, costUsd: 0.8 } }, status: "INFRASTRUCTURE_FAILURE" }, { child: { usage: { inputTokens: 20, costUsd: 0.9 } }, outer: { usage: { outputTokens: 21, costUsd: 1 } }, status: "PASS" }] } } as any);
assert.deepEqual(attemptTelemetry, { input: 30, output: 32, cached: 0, childCost: 1.6, outerCost: 1.8 }, "all billable retry attempts must count");
const spendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-test-"));
try {
	const spendStore = new EvidenceStore(spendRoot); let ledger = new SpendLedger(spendRoot, spendStore, 20, ["PPE-001-I4-SPEND"]);
	ledger.migrateLegacy(10, [{ source: "retained conservative evidence" }]);
	ledger.begin("run-pass", "ROW-1", 2); ledger.record("run-pass", { inputTokens: 10, outputTokens: 2, cachedTokens: 3, costUsd: 0.5, wallTimeMs: 100, participant: "participant" }); ledger.record("run-pass", { inputTokens: 4, outputTokens: 1, cachedTokens: 0, costUsd: 0.1, wallTimeMs: 30, participant: "judge" }); ledger.finish("run-pass", "settled");
	assert.equal(ledger.total(), 10.6); assert.equal(ledger.read().entries[0].attempts.length, 2);
	const summary = ledger.summary(["run-pass"], [5, 10, 15]); assert.equal(summary.currentRunUsd, 0.6); assert.deepEqual(summary.triggeredWarningsUsd, [5, 10]); assert.equal(summary.nextWarningUsd, 15); assert.equal(summary.attempts.length, 2);
	ledger.begin("run-crash", "ROW-2", 2); ledger.record("run-crash", { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.25, wallTimeMs: 10, participant: "participant" });
	ledger = new SpendLedger(spendRoot, spendStore, 20, ["PPE-001-I4-SPEND"]); assert.equal(ledger.read().entries.find((entry) => entry.runId === "run-crash")!.state, "active", "a concurrently live run owner must not be reconciled as crashed"); ledger.finish("run-crash", "failed", "synthetic same-process failure"); assert.equal(ledger.total(), 12.6);
	assert.throws(() => ledger.begin("partial-reservation-forbidden", "ROW-3", 20), /full frozen row reservation|ceiling/); assert.equal(ledger.total(), 12.6);
	const pointer = JSON.parse(fs.readFileSync(path.join(spendRoot, "spend-ledger-v2.json"), "utf8")); fs.writeFileSync(path.join(spendRoot, "spend-ledger-v2.json"), JSON.stringify({ ...pointer, stateHash: HASH_A })); assert.throws(() => ledger.read(), /authentication|mismatch/);
} finally { fs.rmSync(spendRoot, { recursive: true, force: true }); }

const raisedSpendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-raise-test-"));
try {
	const raisedStore = new EvidenceStore(raisedSpendRoot); let raisedLedger = new SpendLedger(raisedSpendRoot, raisedStore, 20, ["PPE-001-I4-SPEND"]);
	raisedLedger.migrateLegacy(17.791287, [{ source: "retained conservative evidence" }]);
	raisedLedger = new SpendLedger(raisedSpendRoot, raisedStore, 100, ["PPE-001-I4-SPEND"]);
	assert.equal(raisedLedger.total(), 17.791287); assert.equal(raisedLedger.read().ceilingUsd, 100); assert.deepEqual(raisedLedger.read().ceilingHistory?.map(({ fromUsd, toUsd }) => ({ fromUsd, toUsd })), [{ fromUsd: 20, toUsd: 100 }]);
} finally { fs.rmSync(raisedSpendRoot, { recursive: true, force: true }); }

const nearCeilingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-near-ceiling-"));
try {
	const store = new EvidenceStore(nearCeilingRoot); const ledger = new SpendLedger(nearCeilingRoot, store, 20, ["PPE-001-I4-SPEND"]);
	ledger.migrateLegacy(19.5, [{ source: "near-ceiling-test" }]);
	assert.throws(() => ledger.begin("must-not-launch", "ROW", 2), /full frozen row reservation.*before launch/);
	assert.equal(ledger.total(), 19.5, "failed reservation must preserve the authenticated total");
} finally { fs.rmSync(nearCeilingRoot, { recursive: true, force: true }); }

function writeOwnedLock(file: string, pid: number, processStart: string, nonce: string): SpendLockRecord {
	const body = { schemaVersion: 1 as const, pid, processStart, nonce, createdAt: new Date().toISOString() };
	const lock: SpendLockRecord = { ...body, lockHash: hashObject(body) };
	fs.writeFileSync(file, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
	return lock;
}
function writeSpendLock(root: string, pid: number, processStart: string, nonce: string): void {
	writeOwnedLock(path.join(root, "spend-ledger-v2.json.lock"), pid, processStart, nonce);
}
function waitForFile(file: string, timeoutMs = 15_000): void {
	const until = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		if (Date.now() >= until) throw new Error(`timed out waiting for ${file}`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
}
const waitExpression = (file: string) => `while(!fs.existsSync(${JSON.stringify(file)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);`;
const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-lock-"));
try {
	const store = new EvidenceStore(lockRoot); const ledger = new SpendLedger(lockRoot, store, 20, ["PPE-001-I4-SPEND"]);
	const currentStart = spendProcessStart(); assert.ok(currentStart);
	writeSpendLock(lockRoot, process.pid, currentStart!, "live-owner");
	assert.throws(() => ledger.begin("blocked-live", "ROW", 1), /live owner/); fs.rmSync(path.join(lockRoot, "spend-ledger-v2.json.lock"));
	writeSpendLock(lockRoot, process.pid, `${currentStart}-pid-reused`, "pid-reuse");
	ledger.begin("reclaimed-reused-pid", "ROW", 1); ledger.finish("reclaimed-reused-pid", "settled");
	writeSpendLock(lockRoot, 2147483647, "dead-process-start", "dead-owner");
	ledger.begin("reclaimed-dead", "ROW", 1); ledger.finish("reclaimed-dead", "settled");
	fs.writeFileSync(path.join(lockRoot, "spend-ledger-v2.json.lock"), "{malformed", { mode: 0o600 });
	assert.throws(() => ledger.begin("malformed-must-not-steal", "ROW", 1), /JSON|malformed|Unexpected/);
} finally { fs.rmSync(lockRoot, { recursive: true, force: true }); }

// Deterministic REVIEW #4 interleaving: A validates the dead owner and pauses;
// B reclaims and acquires a live lock; A resumes and must not remove B's inode.
const twoReclaimerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-two-reclaimer-"));
try {
	new SpendLedger(twoReclaimerRoot, new EvidenceStore(twoReclaimerRoot), 20, ["PPE-001-I4-SPEND"]);
	writeSpendLock(twoReclaimerRoot, 2147483647, "dead-process-start", "shared-dead-owner");
	const spendModule = path.resolve(ROOT, "spend.ts"); const evidenceModule = path.resolve(ROOT, "evidence.ts");
	const aReady = path.join(twoReclaimerRoot, "a-ready"); const aResume = path.join(twoReclaimerRoot, "a-resume"); const aDone = path.join(twoReclaimerRoot, "a-done");
	const bReady = path.join(twoReclaimerRoot, "b-live"); const bResume = path.join(twoReclaimerRoot, "b-resume"); const bDone = path.join(twoReclaimerRoot, "b-done");
	const aScript = `import * as fs from "node:fs"; import { SpendLedger } from ${JSON.stringify(spendModule)}; import { EvidenceStore } from ${JSON.stringify(evidenceModule)}; try { new SpendLedger(${JSON.stringify(twoReclaimerRoot)},new EvidenceStore(${JSON.stringify(twoReclaimerRoot)}),20,["PPE-001-I4-SPEND"],undefined,{afterDeadOwnerValidated(){fs.writeFileSync(${JSON.stringify(aReady)},"ready");${waitExpression(aResume)}}}); fs.writeFileSync(${JSON.stringify(aDone)},"unexpected-success"); } catch(error) { fs.writeFileSync(${JSON.stringify(aDone)},String(error)); }`;
	const bScript = `import * as fs from "node:fs"; import { SpendLedger } from ${JSON.stringify(spendModule)}; import { EvidenceStore } from ${JSON.stringify(evidenceModule)}; new SpendLedger(${JSON.stringify(twoReclaimerRoot)},new EvidenceStore(${JSON.stringify(twoReclaimerRoot)}),20,["PPE-001-I4-SPEND"],undefined,{afterLockAcquired(){fs.writeFileSync(${JSON.stringify(bReady)},"live");${waitExpression(bResume)}}}); fs.writeFileSync(${JSON.stringify(bDone)},"done");`;
	const a = spawn(process.execPath, ["-e", aScript], { stdio: "ignore" }); waitForFile(aReady);
	const b = spawn(process.execPath, ["-e", bScript], { stdio: "ignore" }); waitForFile(bReady);
	fs.writeFileSync(aResume, "resume"); waitForFile(aDone);
	const live = JSON.parse(fs.readFileSync(path.join(twoReclaimerRoot, "spend-ledger-v2.json.lock"), "utf8")) as SpendLockRecord;
	assert.equal(live.pid, b.pid, "late reclaimer A must not remove B's newly acquired live lock");
	assert.match(fs.readFileSync(aDone, "utf8"), /live owner/, "A must refuse the validated live owner");
	fs.writeFileSync(bResume, "resume"); waitForFile(bDone); assert.equal(fs.existsSync(path.join(twoReclaimerRoot, "spend-ledger-v2.json.lock")), false);
	if (a.pid) { try { process.kill(a.pid, 0); } catch {} } if (b.pid) { try { process.kill(b.pid, 0); } catch {} }
} finally { fs.rmSync(twoReclaimerRoot, { recursive: true, force: true }); }

// REVIEW #5 reproducer: a candidate is SIGKILLed after linking a different
// primary inode while an old exact-inode marker exists. First restart must
// recover both dead identities without weakening the live-owner invariant.
const killedCandidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-killed-candidate-"));
try {
	new SpendLedger(killedCandidateRoot, new EvidenceStore(killedCandidateRoot), 20, ["PPE-001-I4-SPEND"]);
	const spendModule = path.resolve(ROOT, "spend.ts"); const evidenceModule = path.resolve(ROOT, "evidence.ts");
	const ready = path.join(killedCandidateRoot, "candidate-ready"); const resume = path.join(killedCandidateRoot, "candidate-resume");
	const script = `import * as fs from "node:fs"; import { SpendLedger } from ${JSON.stringify(spendModule)}; import { EvidenceStore } from ${JSON.stringify(evidenceModule)}; const ledger=new SpendLedger(${JSON.stringify(killedCandidateRoot)},new EvidenceStore(${JSON.stringify(killedCandidateRoot)}),20,["PPE-001-I4-SPEND"],"after-candidate-link",{beforeCandidateLinked(){fs.writeFileSync(${JSON.stringify(ready)},"ready");${waitExpression(resume)}}}); ledger.begin("must-die-before-return","ROW",1);`;
	const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" }); waitForFile(ready);
	const lockFile = path.join(killedCandidateRoot, "spend-ledger-v2.json.lock"); const reclaimFile = `${lockFile}.reclaim`; const old = `${lockFile}.old-dead`;
	writeOwnedLock(old, 2147483647, "old-dead-process-start", "old-dead-marker"); fs.linkSync(old, reclaimFile); fs.rmSync(old);
	fs.writeFileSync(resume, "resume");
	const exit = await new Promise<number | null>((resolve) => child.once("exit", resolve)); assert.notEqual(exit, 0);
	assert.equal(fs.existsSync(lockFile), true); assert.equal(fs.existsSync(reclaimFile), true, "killed pre-return candidate must leave the reachable two-inode state");
	const restarted = new SpendLedger(killedCandidateRoot, new EvidenceStore(killedCandidateRoot), 20, ["PPE-001-I4-SPEND"]);
	restarted.begin("first-restart-after-killed-candidate", "ROW", 1); restarted.finish("first-restart-after-killed-candidate", "settled");
	assert.equal(fs.existsSync(lockFile), false); assert.equal(fs.existsSync(reclaimFile), false, "first restart must clear both dead fenced states");
} finally { fs.rmSync(killedCandidateRoot, { recursive: true, force: true }); }

// Multiprocess stress: all successful full reservations must survive contention;
// callers may retry live-owner refusal, but no split brain may lose an entry.
const stressRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-spend-multiprocess-"));
try {
	new SpendLedger(stressRoot, new EvidenceStore(stressRoot), 20, ["PPE-001-I4-SPEND"]);
	const spendModule = path.resolve(ROOT, "spend.ts"); const evidenceModule = path.resolve(ROOT, "evidence.ts");
	const workers = 8; const children = [];
	for (let index = 0; index < workers; index++) {
		const done = path.join(stressRoot, `stress-${index}.done`);
		const script = `import * as fs from "node:fs"; import { SpendLedger } from ${JSON.stringify(spendModule)}; import { EvidenceStore } from ${JSON.stringify(evidenceModule)}; let last; for(let n=0;n<500;n++){try{const ledger=new SpendLedger(${JSON.stringify(stressRoot)},new EvidenceStore(${JSON.stringify(stressRoot)}),20,["PPE-001-I4-SPEND"]); const entry=ledger.read().entries.find(e=>e.runId==="stress-${index}"); if(!entry) ledger.begin("stress-${index}","ROW-${index}",1); const current=ledger.read().entries.find(e=>e.runId==="stress-${index}"); if(current?.state==="active") ledger.finish("stress-${index}","settled"); if(ledger.read().entries.find(e=>e.runId==="stress-${index}")?.state==="settled"){fs.writeFileSync(${JSON.stringify(done)},"done"); process.exit(0);}}catch(error){last=error;} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);} fs.writeFileSync(${JSON.stringify(done)},"error:"+String(last)); process.exit(1);`;
		children.push(spawn(process.execPath, ["-e", script], { stdio: "ignore" }));
	}
	for (let index = 0; index < workers; index++) { const done = path.join(stressRoot, `stress-${index}.done`); waitForFile(done, 30_000); assert.equal(fs.readFileSync(done, "utf8"), "done"); }
	const final = new SpendLedger(stressRoot, new EvidenceStore(stressRoot), 20, ["PPE-001-I4-SPEND"]).read();
	const entries = final.entries.filter((entry) => entry.runId.startsWith("stress-"));
	assert.equal(entries.length, workers, "serialized multiprocess transactions must preserve every reservation entry");
	assert.equal(new Set(entries.map((entry) => entry.runId)).size, workers); assert.ok(entries.every((entry) => entry.state === "settled"));
	for (const child of children) if (child.pid) { try { process.kill(child.pid, 0); } catch {} }
} finally { fs.rmSync(stressRoot, { recursive: true, force: true }); }

for (const crashPoint of ["after-lock", "after-read", "after-persist"] as const) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `model-quality-spend-killed-${crashPoint}-`));
	try {
		const store = new EvidenceStore(root); new SpendLedger(root, store, 20, ["PPE-001-I4-SPEND"]);
		const spendModule = path.resolve(ROOT, "spend.ts"); const evidenceModule = path.resolve(ROOT, "evidence.ts");
		const script = `import { SpendLedger } from ${JSON.stringify(spendModule)}; import { EvidenceStore } from ${JSON.stringify(evidenceModule)}; const root=${JSON.stringify(root)}; const store=new EvidenceStore(root); const ledger=new SpendLedger(root,store,20,["PPE-001-I4-SPEND"],${JSON.stringify(crashPoint)}); ledger.begin("killed-${crashPoint}","ROW",2);`;
		const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
		assert.notEqual(child.status, 0, `${crashPoint} child must be killed at the transaction boundary`);
		let restarted = new SpendLedger(root, new EvidenceStore(root), 20, ["PPE-001-I4-SPEND"]);
		if (crashPoint !== "after-persist") { restarted.begin(`restarted-${crashPoint}`, "ROW", 1); restarted.finish(`restarted-${crashPoint}`, "settled"); }
		else assert.equal(restarted.read().entries.find((entry) => entry.runId === `killed-${crashPoint}`)?.state, "failed");
		assert.equal(fs.existsSync(path.join(root, "spend-ledger-v2.json.lock")), false, "first restart must reclaim only the dead owner lock");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const retryThenPass = boundedOutcome("FROZEN-SLOT", 2, (attempt) => ({ classification: attempt === 1 ? "INFRASTRUCTURE_FAILURE" : "PASS", evidenceRef: `sha256:${attempt}` }));
assert.equal(retryThenPass.attempts.length, 2);
assert.equal(retryThenPass.scoredClassification, "PASS");
assert.ok(retryThenPass.attempts.every((attempt) => attempt.slotId === "FROZEN-SLOT"), "bounded retry may only reuse the same frozen slot");
const exhausted = boundedOutcome("EXHAUSTED", 2, (attempt) => ({ classification: "INFRASTRUCTURE_FAILURE", evidenceRef: `sha256:${attempt}` }));
assert.equal(exhausted.slotState, "INFRASTRUCTURE_EXHAUSTED");
const candidateStops = boundedOutcome("FAILED", 3, () => ({ classification: "CANDIDATE_FAILURE", evidenceRef: "sha256:candidate" }));
assert.equal(candidateStops.attempts.length, 1, "candidate failure must not receive an infrastructure retry");
assert.deepEqual(qualitativeDenominator([retryThenPass, exhausted, candidateStops]), { frozenSlots: 3, judged: 1, excluded: { JUDGED: 1, NOT_ELIGIBLE_CANDIDATE: 1, INCONCLUSIVE_BASELINE: 0, INCONCLUSIVE_EVALUATOR: 0, INFRASTRUCTURE_EXHAUSTED: 1 } });
assert.equal(classifyInfrastructure({ authentication: true }), "infrastructure");
assert.equal(classifyInfrastructure({}), "scored");

function validEvidence(phase: PhaseEvidence["phase"]): PhaseEvidence {
	return { phase, runtimeIdentityMatch: true, artifactValid: true, cleanupPassed: true, behaviorPassed: true, mutationPassed: true, gitPassed: true, knownOutcomeCorrect: true, readOnlyPassed: true, blockerSupported: true, falsePositive: false, evidenceBacked: true, fabricationFree: true, judgeRequested: false };
}
for (const phase of ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"] as const) assert.equal(scorePhaseEvidence(validEvidence(phase)).passed, true);
for (const field of ["runtimeIdentityMatch", "artifactValid", "cleanupPassed", "behaviorPassed", "mutationPassed", "gitPassed"] as const) assert.equal(scorePhaseEvidence({ ...validEvidence("IMPLEMENT"), [field]: false }).passed, false);
assert.equal(scorePhaseEvidence({ ...validEvidence("VERIFY"), knownOutcomeCorrect: false }).passed, false);
assert.equal(scorePhaseEvidence({ ...validEvidence("VERIFY"), readOnlyPassed: false }).passed, false);
assert.equal(scorePhaseEvidence({ ...validEvidence("REVIEW"), falsePositive: true }).passed, false);
assert.equal(scorePhaseEvidence({ ...validEvidence("CLOSE"), judgeRequested: true }).passed, false);
assert.equal(scorePhaseEvidence({ ...validEvidence("RETRO"), evidenceBacked: false }).passed, false);
assert.equal(scorePhaseEvidence({ ...validEvidence("RETRO"), fabricationFree: false }).passed, false);
assert.deepEqual(falseRates([{ expectedPass: false, actualPass: true }, { expectedPass: true, actualPass: false }, { expectedPass: true, actualPass: true, supportedBlocker: false }]), { falsePasses: 1, falseFails: 1, falsePositives: 1 });

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-evidence-test-"));
try {
	const store = new EvidenceStore(evidenceRoot);
	const secret = "secret-value-12345678";
	const record = store.put({ value: { api_key: secret, rawTranscript: "private", safe: "retained" }, schemaVersionRef: "v1", assetVersions: ["asset-v1"], participantProvenance: ["fake/model@v1"], retentionUntil: "2099-01-01T00:00:00.000Z", explicitSecrets: [secret] });
	const retained = store.get(record).toString("utf8");
	assert.doesNotMatch(retained, /secret-value|private/);
	assert.match(retained, /REDACTED|OMITTED/);
	assert.deepEqual(store.audit(), { objects: 1, indexes: 1 });
	assert.equal(store.getByRef(record.retrievalRef, { schemaVersionRef: "v1", assetVersions: ["asset-v1"], participantProvenance: ["fake/model@v1"] }).record.contentHash, record.contentHash);
	const originalIndex = fs.readdirSync(store.indexRoot)[0]; const originalIndexPath = path.join(store.indexRoot, originalIndex); const originalIndexText = fs.readFileSync(originalIndexPath, "utf8"); const tamperedIndex = JSON.parse(originalIndexText); tamperedIndex.participantProvenance = ["attacker/model@v9"]; fs.writeFileSync(originalIndexPath, JSON.stringify(tamperedIndex)); assert.throws(() => store.indexes(), /authentication/); fs.writeFileSync(originalIndexPath, originalIndexText);
	fs.copyFileSync(originalIndexPath, path.join(store.indexRoot, "duplicate.json"));
	assert.throws(() => store.getByRef(record.retrievalRef), /exactly one/); fs.rmSync(path.join(store.indexRoot, "duplicate.json"));
	fs.writeFileSync(path.join(store.objectRoot, HASH_B), "orphan", { mode: 0o600 }); assert.throws(() => store.audit(), /orphan/); fs.rmSync(path.join(store.objectRoot, HASH_B));
	fs.rmSync(path.join(store.objectRoot, record.contentHash));
	assert.throws(() => store.get(record), /unavailable/);
	const expired: any = { ...record, retentionUntil: "2000-01-01T00:00:00.000Z" }; const { indexHash: _expiredHash, ...expiredBody } = expired; expired.indexHash = sha256(JSON.stringify(Object.fromEntries(Object.entries(expiredBody).sort(([a], [b]) => a.localeCompare(b))))); assert.throws(() => store.get(expired), /expired|authentication/);
	assert.throws(() => new EvidenceStore("relative/path"), /absolute/);
	assertRedacted(redactValue({ token: secret }, [secret]), [secret]);
} finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }

function makeGuard(root: string): AdmissionGuard {
	return new AdmissionGuard(root, { id: "BOOT-VERIFY", version: 1, itemHash: HASH_A, catalogHash: HASH_B }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST, undefined, (hash) => [HASH_A, HASH_B, HASH_C].includes(hash));
}
function report(key: string, reportClass = "credible-bootstrap-leakage", actorId = "bootstrap-incident-service"): IncidentReport {
	return { idempotencyKey: key, itemId: "BOOT-VERIFY", itemVersion: 1, itemHash: HASH_A, catalogHash: HASH_B, evidenceHash: HASH_C, reportClass, actorId };
}
const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-guard-test-"));
try {
	const guard = makeGuard(guardRoot);
	const selection = guard.authorize("selection");
	const before = guard.publish({ id: "result-before", kind: "result-use", expectedSequence: selection.sequence, evidenceHash: HASH_A });
	assert.equal(before.eligibility, "eligible");
	const held = guard.applyIncident(report("incident-1"));
	assert.equal(held.acknowledged, true);
	assert.equal(guard.snapshot().publications[0].eligibility, "TAINTED_OR_INVALIDATED", "publication-first ordering must taint before hold acknowledgement");
	assert.throws(() => guard.authorize("dispatch"), /not effectively admitted/);
	const stale = guard.publish({ id: "result-after", kind: "report", expectedSequence: selection.sequence, evidenceHash: HASH_B });
	assert.equal(stale.eligibility, "TAINTED_OR_INVALIDATED", "hold-first ordering must reject stale publication");
	assert.equal(guard.applyIncident(report("incident-1")).sequence, held.sequence, "duplicate incident must be idempotent");
	assert.throws(() => guard.applyIncident({ ...report("incident-1"), evidenceHash: HASH_A }), /replay/);
	assert.equal(guard.applyIncident(report("incident-2", "credible-bootstrap-leakage-critical")).decision.severity, 3);
	assert.throws(() => guard.applyIncident(report("incident-3")), /downgrade/);
	assert.throws(() => guard.applyIncident(report("incident-unauthorized", "credible-bootstrap-leakage", "evaluated-model")), /allowlisted/);
	assert.throws(() => guard.applyIncident({ ...report("incident-stale"), itemHash: HASH_C }), /stale|mismatched/);
	assert.throws(() => guard.applyIncident({ ...report("incident-missing-evidence"), evidenceHash: hashObject("not-retained") }), /not durably retained/);
	const incidentSequence = guard.snapshot().sequence;
	assert.throws(() => guard.resolve({ action: "dismiss", actorId: "service", actorRole: "authorized-human", signedIntent: "", itemHash: HASH_A, catalogHash: HASH_B, incidentKeys: ["incident-1"], expectedSequence: incidentSequence, reason: "none" }), /signed/);
	assert.throws(() => guard.resolve({ action: "dismiss", actorId: "human-1", actorRole: "authorized-human", signedIntent: "forged", itemHash: HASH_A, catalogHash: HASH_B, incidentKeys: ["incident-1"], expectedSequence: incidentSequence, reason: "synthetic false positive" }), /verified/);
	const partial = guard.resolve(signSyntheticHumanResolution({ action: "dismiss", actorId: "human-1", itemHash: HASH_A, catalogHash: HASH_B, incidentKeys: ["incident-1"], expectedSequence: incidentSequence, reason: "first report was a false positive" }));
	assert.equal(partial.holdState, "pending", "unrelated critical incident must remain pending");
	assert.equal(partial.incidents.find((entry: any) => entry.report.idempotencyKey === "incident-2")!.status, "pending");
	assert.throws(() => guard.resolve(signSyntheticHumanResolution({ action: "dismiss", actorId: "human-1", itemHash: HASH_A, catalogHash: HASH_B, incidentKeys: ["incident-2"], expectedSequence: incidentSequence, reason: "stale" })), /stale/);
	const dismissed = guard.resolve(signSyntheticHumanResolution({ action: "dismiss", actorId: "human-1", itemHash: HASH_A, catalogHash: HASH_B, incidentKeys: ["incident-2"], expectedSequence: partial.sequence, reason: "second report independently resolved" }));
	assert.equal(dismissed.holdState, "clear");
	const fresh = guard.authorize("dispatch");
	assert.ok(fresh.sequence > selection.sequence);
	assert.equal(guard.publish({ id: "joined", kind: "join", expectedSequence: fresh.sequence, evidenceHash: HASH_C }).eligibility, "eligible");
	assert.equal(guard.publish({ id: "joined", kind: "join", expectedSequence: fresh.sequence, evidenceHash: HASH_C }).eligibility, "eligible", "publication retry must not duplicate");
} finally { fs.rmSync(guardRoot, { recursive: true, force: true }); }

// Rejected incident outcomes reserve their idempotency keys just like holds.
// Exact retries remain no-ops across restart; content drift always fails.
const rejectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-rejected-idempotency-"));
try {
	let guard = makeGuard(rejectRoot);
	const rejectedReport = report("rejected-1", "untrusted-report");
	const rejected = guard.applyIncident(rejectedReport);
	assert.equal(rejected.acknowledged, false);
	assert.equal(guard.snapshot().sequence, 0);
	const auditLength = guard.snapshot().audit.length;
	guard = makeGuard(rejectRoot);
	assert.deepEqual(guard.applyIncident(rejectedReport), rejected, "identical rejected replay after restart must return its original decision");
	assert.equal(guard.snapshot().audit.length, auditLength, "identical rejected replay must not mutate audit state");
	assert.throws(() => guard.applyIncident(report("rejected-1")), /replay/, "changed rejected replay must never become a hold");
	assert.equal((guard.snapshot() as any).incidentRecords.length, 1);

	const admissionModule = path.resolve(ROOT, "admission.ts");
	const sameDone = path.join(rejectRoot, "same-done"); const changedDone = path.join(rejectRoot, "changed-done");
	const guardArgs = `${JSON.stringify(rejectRoot)},{id:"BOOT-VERIFY",version:1,itemHash:${JSON.stringify(HASH_A)},catalogHash:${JSON.stringify(HASH_B)}},SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST,undefined,()=>true`;
	const concurrentScript = (done: string, value: IncidentReport) => `import * as fs from "node:fs"; import { AdmissionGuard,SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST } from ${JSON.stringify(admissionModule)}; const until=Date.now()+10000; for(;;){try{const guard=new AdmissionGuard(${guardArgs});fs.writeFileSync(${JSON.stringify(done)},JSON.stringify(guard.applyIncident(${JSON.stringify(value)})));break;}catch(error){if(String(error).includes("live owner")&&Date.now()<until){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);continue;}fs.writeFileSync(${JSON.stringify(done)},String(error));break;}}`;
	const sameScript = concurrentScript(sameDone, rejectedReport);
	const changedReport = report("rejected-1");
	const changedScript = concurrentScript(changedDone, changedReport);
	const same = spawn(process.execPath, ["-e", sameScript], { stdio: "ignore" }); const changed = spawn(process.execPath, ["-e", changedScript], { stdio: "ignore" });
	waitForFile(sameDone); waitForFile(changedDone);
	assert.equal(JSON.parse(fs.readFileSync(sameDone, "utf8")).acknowledged, false, "concurrent identical rejected replay must return the original rejection");
	assert.match(fs.readFileSync(changedDone, "utf8"), /replay/, "concurrent changed rejected replay must fail");
	if (same.pid) { try { process.kill(same.pid, 0); } catch {} } if (changed.pid) { try { process.kill(changed.pid, 0); } catch {} }
	assert.equal((makeGuard(rejectRoot).snapshot() as any).incidentRecords.length, 1);
} finally { fs.rmSync(rejectRoot, { recursive: true, force: true }); }

for (const kind of ["result-use", "join", "report"] as const) {
	for (const order of ["publication-first", "hold-first"] as const) {
		assert.throws(() => admissionRunnerProbe(order, kind), /admission publication|incomplete or tainted/, `actual runner/report ${order} ${kind} must fail closed`);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `model-quality-linearization-${kind}-${order}-`));
		try {
			const guard = makeGuard(root); const authorization = guard.authorize("dispatch");
			if (order === "publication-first") {
				assert.equal(guard.publish({ id: `${kind}-before`, kind, expectedSequence: authorization.sequence, evidenceHash: HASH_A }).eligibility, "eligible");
				guard.applyIncident(report(`${kind}-incident`));
				assert.equal(guard.snapshot().publications[0].eligibility, "TAINTED_OR_INVALIDATED");
			} else {
				guard.applyIncident(report(`${kind}-incident`));
				assert.equal(guard.publish({ id: `${kind}-after`, kind, expectedSequence: authorization.sequence, evidenceHash: HASH_A }).eligibility, "TAINTED_OR_INVALIDATED");
			}
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	}
}

const quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-quarantine-test-"));
try {
	const guard = makeGuard(quarantineRoot);
	guard.applyIncident(report("q-1"));
	const state = guard.resolve(signSyntheticHumanResolution({ action: "quarantine", actorId: "human-2", itemHash: HASH_A, catalogHash: HASH_B, incidentKeys: ["q-1"], expectedSequence: guard.snapshot().sequence, reason: "confirmed leakage" }));
	assert.equal(state.admissionState, "quarantined");
	assert.throws(() => guard.authorize("selection"), /not effectively admitted/);
	assert.throws(() => guard.resolve(signSyntheticHumanResolution({ action: "dismiss", actorId: "human-2", itemHash: HASH_C, catalogHash: HASH_B, incidentKeys: ["q-1"], expectedSequence: state.sequence, reason: "changed" })), /hashes changed|no pending/);
} finally { fs.rmSync(quarantineRoot, { recursive: true, force: true }); }

const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-recovery-test-"));
try {
	const guard = makeGuard(recoveryRoot);
	const state: any = guard.snapshot();
	state.sequence += 1; state.holdState = "pending"; state.audit.push({ sequence: state.sequence, action: "simulated-crash", evidenceHash: HASH_C });
	fs.writeFileSync(path.join(recoveryRoot, "BOOT-VERIFY-1.json.journal"), `${JSON.stringify({ schemaVersion: 1, state, stateHash: hashObject(state) })}\n`);
	const recovered = makeGuard(recoveryRoot);
	assert.equal(recovered.snapshot().holdState, "pending");
	assert.throws(() => recovered.authorize("selection"), /not effectively admitted/);
	const admissionLock = path.join(recoveryRoot, "BOOT-VERIFY-1.json.lock");
	const currentStart = spendProcessStart(); assert.ok(currentStart);
	writeOwnedLock(admissionLock, process.pid, currentStart!, "admission-live-owner");
	assert.throws(() => makeGuard(recoveryRoot), /live owner/, "a live admission owner must never be removed");
	fs.rmSync(admissionLock);
	writeOwnedLock(admissionLock, process.pid, `${currentStart}-pid-reused`, "admission-pid-reused");
	assert.equal(makeGuard(recoveryRoot).snapshot().holdState, "pending", "PID-reused admission owner must be reclaimed on first restart");
	writeOwnedLock(admissionLock, 2147483647, "dead-process-start", "admission-dead-owner");
	assert.equal(makeGuard(recoveryRoot).snapshot().holdState, "pending", "dead admission owner must be reclaimed on first restart");
	fs.writeFileSync(admissionLock, "{malformed", { mode: 0o600 });
	assert.throws(() => makeGuard(recoveryRoot), /malformed|JSON|Unexpected/, "malformed admission ownership must fail closed");
	assert.equal(fs.existsSync(admissionLock), true, "malformed ownership must not be stolen");
} finally { fs.rmSync(recoveryRoot, { recursive: true, force: true }); }

// A malformed or unauthenticated committed journal remains fail-closed and is
// never confused with an uncommitted temporary file.
for (const journalBody of ["{malformed", JSON.stringify({ schemaVersion: 1, state: { itemId: "BOOT-VERIFY" }, stateHash: HASH_A })]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-bad-admission-journal-"));
	try {
		makeGuard(root); const journal = path.join(root, "BOOT-VERIFY-1.json.journal"); fs.writeFileSync(journal, journalBody);
		assert.throws(() => makeGuard(root), /JSON|authentication/, "committed invalid journal must fail closed");
		assert.equal(fs.existsSync(journal), true, "committed invalid journal must remain for operator inspection");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Admission transaction interruption is recovered under the same authenticated
// lock before admission reopens. Uncommitted partial/full temporary journals are
// discarded; a committed journal replays the pending hold on first restart.
for (const crashPoint of ["after-lock", "during-journal-write", "before-journal-publish", "after-journal", "after-state"] as const) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `model-quality-admission-killed-${crashPoint}-`));
	try {
		makeGuard(root);
		const admissionModule = path.resolve(ROOT, "admission.ts");
		const script = `import { AdmissionGuard,SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST } from ${JSON.stringify(admissionModule)}; const guard=new AdmissionGuard(${JSON.stringify(root)},{id:"BOOT-VERIFY",version:1,itemHash:${JSON.stringify(HASH_A)},catalogHash:${JSON.stringify(HASH_B)}},SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST,undefined,()=>true,${JSON.stringify(crashPoint)}); guard.applyIncident({idempotencyKey:"killed-${crashPoint}",itemId:"BOOT-VERIFY",itemVersion:1,itemHash:${JSON.stringify(HASH_A)},catalogHash:${JSON.stringify(HASH_B)},evidenceHash:${JSON.stringify(HASH_C)},reportClass:"credible-bootstrap-leakage",actorId:"bootstrap-incident-service"});`;
		const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }); assert.notEqual(child.status, 0);
		const restarted = makeGuard(root); const snapshot: any = restarted.snapshot();
		const committed = crashPoint === "after-journal" || crashPoint === "after-state";
		assert.equal(snapshot.holdState, committed ? "pending" : "clear", `${crashPoint} must reconcile on first restart`);
		assert.equal(fs.readdirSync(root).some((entry) => entry.includes(".journal")), false, `${crashPoint} journal artifacts must be reconciled`);
		assert.equal(fs.existsSync(path.join(root, "BOOT-VERIFY-1.json.lock")), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// A process killed before returning admission lock ownership leaves an
// authenticated dead record, which the first restart reclaims.
const admissionCandidateKillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-admission-killed-candidate-"));
try {
	makeGuard(admissionCandidateKillRoot);
	const admissionModule = path.resolve(ROOT, "admission.ts");
	const script = `import { AdmissionGuard,SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST } from ${JSON.stringify(admissionModule)}; new AdmissionGuard(${JSON.stringify(admissionCandidateKillRoot)},{id:"BOOT-VERIFY",version:1,itemHash:${JSON.stringify(HASH_A)},catalogHash:${JSON.stringify(HASH_B)}},SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST,undefined,()=>true,"after-candidate-link");`;
	const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }); assert.notEqual(child.status, 0);
	assert.equal(fs.existsSync(path.join(admissionCandidateKillRoot, "BOOT-VERIFY-1.json.lock")), true);
	assert.doesNotThrow(() => makeGuard(admissionCandidateKillRoot));
	assert.equal(fs.existsSync(path.join(admissionCandidateKillRoot, "BOOT-VERIFY-1.json.lock")), false);
} finally { fs.rmSync(admissionCandidateKillRoot, { recursive: true, force: true }); }

// Concurrent admission reclaimers cannot steal the newly acquired live inode.
const admissionTwoReclaimerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-admission-two-reclaimer-"));
try {
	makeGuard(admissionTwoReclaimerRoot);
	const lockFile = path.join(admissionTwoReclaimerRoot, "BOOT-VERIFY-1.json.lock"); writeOwnedLock(lockFile, 2147483647, "dead-process-start", "admission-shared-dead");
	const admissionModule = path.resolve(ROOT, "admission.ts");
	const aReady = path.join(admissionTwoReclaimerRoot, "a-ready"); const aResume = path.join(admissionTwoReclaimerRoot, "a-resume"); const aDone = path.join(admissionTwoReclaimerRoot, "a-done");
	const bReady = path.join(admissionTwoReclaimerRoot, "b-ready"); const bResume = path.join(admissionTwoReclaimerRoot, "b-resume"); const bDone = path.join(admissionTwoReclaimerRoot, "b-done");
	const args = `{id:"BOOT-VERIFY",version:1,itemHash:${JSON.stringify(HASH_A)},catalogHash:${JSON.stringify(HASH_B)}},SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST,undefined,()=>true,undefined`;
	const aScript = `import * as fs from "node:fs"; import { AdmissionGuard,SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST } from ${JSON.stringify(admissionModule)}; try{new AdmissionGuard(${JSON.stringify(admissionTwoReclaimerRoot)},${args},{afterDeadOwnerValidated(){fs.writeFileSync(${JSON.stringify(aReady)},"ready");${waitExpression(aResume)}}});fs.writeFileSync(${JSON.stringify(aDone)},"unexpected-success");}catch(error){fs.writeFileSync(${JSON.stringify(aDone)},String(error));}`;
	const bScript = `import * as fs from "node:fs"; import { AdmissionGuard,SYNTHETIC_INCIDENT_POLICY,SYNTHETIC_SERVICE_ALLOWLIST } from ${JSON.stringify(admissionModule)}; new AdmissionGuard(${JSON.stringify(admissionTwoReclaimerRoot)},${args},{afterLockAcquired(){fs.writeFileSync(${JSON.stringify(bReady)},"live");${waitExpression(bResume)}}});fs.writeFileSync(${JSON.stringify(bDone)},"done");`;
	const a = spawn(process.execPath, ["-e", aScript], { stdio: "ignore" }); waitForFile(aReady);
	const b = spawn(process.execPath, ["-e", bScript], { stdio: "ignore" }); waitForFile(bReady);
	fs.writeFileSync(aResume, "resume"); waitForFile(aDone);
	const live = JSON.parse(fs.readFileSync(lockFile, "utf8")); assert.equal(live.pid, b.pid); assert.match(fs.readFileSync(aDone, "utf8"), /live owner/);
	fs.writeFileSync(bResume, "resume"); waitForFile(bDone); assert.equal(fs.existsSync(lockFile), false);
	if (a.pid) { try { process.kill(a.pid, 0); } catch {} } if (b.pid) { try { process.kill(b.pid, 0); } catch {} }
} finally { fs.rmSync(admissionTwoReclaimerRoot, { recursive: true, force: true }); }

for (const fault of ["after-prepare", "after-evidence", "after-guard"] as const) {
	const crossStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), `model-quality-cross-store-${fault}-`));
	try {
		const store = new EvidenceStore(path.join(crossStoreRoot, "evidence"));
		let coordinator = new EvidenceAdmissionCoordinator(path.join(crossStoreRoot, "admission"), store, { id: "BOOT-VERIFY", version: 1, itemHash: HASH_A, catalogHash: HASH_B }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
		const authorization = coordinator.authorize("dispatch"); const retentionUntil = "2099-01-01T00:00:00.000Z";
		assert.throws(() => coordinator.publish({ id: `publication-${fault}`, publicationKind: "report", expectedSequence: authorization.sequence, value: { boundary: "report", fault }, schemaVersionRef: "cross-store-v2", assetVersions: ["asset-v2"], participantProvenance: ["bootstrap/service"], retentionUntil }, fault), /simulated/);
		coordinator = new EvidenceAdmissionCoordinator(path.join(crossStoreRoot, "admission"), store, { id: "BOOT-VERIFY", version: 1, itemHash: HASH_A, catalogHash: HASH_B }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
		assert.equal(coordinator.snapshot().publications[0].eligibility, "eligible", `publication ${fault} must reconcile idempotently`);
		assert.throws(() => coordinator.incident({ report: { ...report(`incident-${fault}`), evidenceHash: undefined } as any, value: { incident: fault }, schemaVersionRef: "cross-store-incident-v2", assetVersions: ["asset-v2"], participantProvenance: ["bootstrap/service"], retentionUntil }, fault), /simulated/);
		coordinator = new EvidenceAdmissionCoordinator(path.join(crossStoreRoot, "admission"), store, { id: "BOOT-VERIFY", version: 1, itemHash: HASH_A, catalogHash: HASH_B }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
		const snapshot: any = coordinator.snapshot(); assert.equal(snapshot.holdState, "pending"); assert.equal(snapshot.publications[0].eligibility, "TAINTED_OR_INVALIDATED"); assert.throws(() => coordinator.authorize("selection"), /not effectively admitted/);
		assert.deepEqual(store.audit().objects, store.audit().indexes);
	} finally { fs.rmSync(crossStoreRoot, { recursive: true, force: true }); }
}

const baseRow = manifest.rows[0];
const slot = (overrides: Partial<NormalizedSlotResult> = {}): NormalizedSlotResult => ({ slotId: "S", itemId: "BOOT-X", itemVersion: 1, phase: "IMPLEMENT", datasetClass: "bootstrap", qualificationEligible: false, requested: structuredClone(baseRow.candidate), effective: structuredClone(baseRow.candidate), nonTargetRoutes: structuredClone(baseRow.nonTargetRoutes), judgeIdentity: structuredClone(baseRow.judge), judgeUsage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.1, wallTimeMs: 10 }, admission: { itemHash: HASH_A, catalogHash: manifest.manifestHash, selectionSequence: 0, dispatchSequence: 0, publications: [{ id: "result", kind: "result-use", sequence: 0, eligibility: "eligible", evidenceHash: HASH_A, evidenceRef: `sha256:${HASH_A}` }, { id: "report", kind: "report", sequence: 0, eligibility: "eligible", evidenceHash: HASH_B, evidenceRef: `sha256:${HASH_B}` }] }, isolation: { repository: "disposable://repo", piHome: "disposable://home", artifactRoot: "disposable://artifact", resultNamespace: "slot:S", processGroup: "isolated:S", credentialBoundary: "allowlisted-ephemeral", remotePolicy: "none" }, cleanupPassed: true, redactionPassed: true, status: "PASS", slotState: "JUDGED", deterministicPassed: true, qualitativeEligible: true, attempts: 2, infrastructureAttempts: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 2, childCostUsd: 2, outerCostUsd: 1, wallTimeMs: 200, firstPlannedPassCostUsd: 2, defaultFirstPlannedPassWallTimeMs: 100, minimumPlannedAttempts: 1, handoffs: ["a->b"], evidenceRefs: ["sha256:x"], ...overrides });
const matchingSlot = { ...slot(), slotId: baseRow.slotId, itemId: baseRow.itemId, phase: baseRow.phase, handoffs: [] };
assert.doesNotThrow(() => validateSlotResult(matchingSlot, baseRow));
assert.throws(() => validateSlotResult({ ...matchingSlot, effective: { ...matchingSlot.effective, model: "wrong" } }, baseRow), /identity/);
assert.throws(() => validateSlotResult({ ...matchingSlot, cleanupPassed: false }, baseRow), /cleanup/);
const e2eRow = manifest.rows.find((row) => row.phase === "E2E")!;
const e2eResult = fakeFull().slots.find((entry) => entry.phase === "E2E")!;
assert.doesNotThrow(() => validateSlotResult(e2eResult, e2eRow));
assert.throws(() => validateSlotResult({ ...e2eResult, handoffs: e2eResult.handoffs.slice(0, 3) }, e2eRow), /handoffs/);
const metrics = joinedMetrics([slot(), slot({ slotId: "T", status: "INFRASTRUCTURE_FAILURE", slotState: "INFRASTRUCTURE_EXHAUSTED", attempts: 2, infrastructureAttempts: 2 })]);
assert.equal(metrics.totalCostUsd, 6);
assert.equal(metrics.repairAmplification, 0.5);
assert.equal(metrics.costAmplification, 1.5);
assert.equal(metrics.latencyAmplification, 2);
assert.equal(metrics.reliability, 1);
const reportValue = buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots: [slot()], generatedAt: "2026-07-21T00:00:00.000Z" });
assert.match(reportValue.classification, /NOT QUALIFICATION EVIDENCE/);
assert.equal((reportValue as any).adoption, undefined);
assert.throws(() => adoptionDecision(reportValue), /never emit/);
assert.throws(() => buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots: [slot({ qualificationEligible: true })] }), /forbidden/);

const reproduced = fakeFull();
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "reports", "bootstrap-expected.json"), "utf8"));
assert.deepEqual(reproduced, expected);
assert.equal(reproduced.slots.length, 6);
assert.equal(reproduced.metrics.handoffCount, 4);
assert.equal(auditCleanClone().reportHash, reproduced.reportHash);

const canary = spawnSync(process.execPath, [path.join(ROOT, "run.ts"), "bootstrap-canary"], { cwd: ROOT, env: { ...process.env, MODEL_QUALITY_CANARY: "0" }, encoding: "utf8" });
assert.notEqual(canary.status, 0);
assert.match(canary.stderr, /fail-closed/);

console.log("model-quality infrastructure tests passed");
