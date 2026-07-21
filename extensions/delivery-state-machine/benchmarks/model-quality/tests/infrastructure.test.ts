import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AdmissionGuard, signSyntheticHumanResolution, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST, type IncidentReport } from "../admission.ts";
import { aggregateResultUsage, loadRealCanary, validateConnectedHandoffs, type HandoffRecord } from "../canary.ts";
import { EvidenceStore, assertRedacted, redactValue } from "../evidence.ts";
import { assertExactSparseSelection, loadBootstrapAssets, loadManifest, loadRegistry, resolveRows } from "../manifest.ts";
import { lifecycleRecord, validateLifecycleTransition } from "../lifecycle.ts";
import { adoptionDecision, buildInfrastructureReport, joinedMetrics } from "../report.ts";
import { boundedOutcome, qualitativeDenominator } from "../outcome.ts";
import { classifyInfrastructure, falseRates, scorePhaseEvidence } from "../scorers/index.ts";
import { assertBootstrapNonQualification, canModelBlockDeterministicPass, hashObject, manifestContent, validateDatasetItem, validateHumanReview, validateManifest, validateSlotResult, type NormalizedSlotResult, type PhaseEvidence } from "../schema.ts";
import { assertJudgeIndependence, blockerConfirmed, buildJudgePack, parseJudgeResponse } from "../judge.ts";
import { auditCleanClone, fakeFull, validateInfrastructure } from "../run.ts";
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
const connectedHandoffs: HandoffRecord[] = ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"].map((edge, index) => { const [from, to] = edge.split("->"); return { from, to, sequence: index + 1, outboundHash: HASH_A, inboundHash: HASH_A, taskId: "TASK-1", repositoryId: "REPO-1" }; });
assert.deepEqual(validateConnectedHandoffs(connectedHandoffs), ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"]);
assert.throws(() => validateConnectedHandoffs(connectedHandoffs.slice(0, 3)), /incomplete/);
assert.throws(() => validateConnectedHandoffs(connectedHandoffs.map((entry, index) => index === 1 ? { ...entry, inboundHash: HASH_B } : entry)), /mismatched/);
assert.throws(() => validateConnectedHandoffs(connectedHandoffs.map((entry, index) => index === 2 ? { ...entry, repositoryId: "REPO-2" } : entry)), /disconnected/);

const realCanary = loadRealCanary();
assert.equal(realCanary.manifest.rows.length, 6);
assert.equal(realCanary.manifest.rows.reduce((sum, row) => sum + row.budgetUsd, 0), 18);
assert.equal(realCanary.config.limits.totalCostUsd, 20);
assert.deepEqual(realCanary.config.credentialPolicy.forwardedEnvironment, []);
assert.deepEqual(realCanary.config.rows.find((row) => row.phase === "REVIEW")?.scenarioIds, ["REV-01", "REV-01"]);
assert.equal(realCanary.manifest.rows.find((row) => row.phase === "CLOSE")?.judge, undefined);
assert.equal(realCanary.manifest.rows.find((row) => row.phase === "E2E")?.judge, undefined);

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
	const originalIndex = fs.readdirSync(store.indexRoot)[0]; fs.copyFileSync(path.join(store.indexRoot, originalIndex), path.join(store.indexRoot, "duplicate.json"));
	assert.throws(() => store.getByRef(record.retrievalRef), /exactly one/); fs.rmSync(path.join(store.indexRoot, "duplicate.json"));
	fs.writeFileSync(path.join(store.objectRoot, HASH_B), "orphan", { mode: 0o600 }); assert.throws(() => store.audit(), /orphan/); fs.rmSync(path.join(store.objectRoot, HASH_B));
	fs.rmSync(path.join(store.objectRoot, record.contentHash));
	assert.throws(() => store.get(record), /unavailable/);
	assert.throws(() => store.get({ ...record, retentionUntil: "2000-01-01T00:00:00.000Z" }), /expired/);
	assert.throws(() => new EvidenceStore("relative/path"), /absolute/);
	assertRedacted(redactValue({ token: secret }, [secret]), [secret]);
} finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }

function makeGuard(root: string): AdmissionGuard {
	return new AdmissionGuard(root, { id: "BOOT-VERIFY", version: 1, itemHash: HASH_A, catalogHash: HASH_B }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
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

for (const kind of ["result-use", "join", "report"] as const) {
	for (const order of ["publication-first", "hold-first"] as const) {
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
	fs.writeFileSync(path.join(recoveryRoot, "BOOT-VERIFY-1.json.journal"), `${JSON.stringify(state)}\n`);
	const recovered = makeGuard(recoveryRoot);
	assert.equal(recovered.snapshot().holdState, "pending");
	assert.throws(() => recovered.authorize("selection"), /not effectively admitted/);
	fs.writeFileSync(path.join(recoveryRoot, "BOOT-VERIFY-1.json.lock"), "99999999\n");
	assert.equal(makeGuard(recoveryRoot).snapshot().holdState, "pending", "restart must reclaim a demonstrably dead lock owner");
} finally { fs.rmSync(recoveryRoot, { recursive: true, force: true }); }

const crossStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-quality-cross-store-test-"));
try {
	const store = new EvidenceStore(path.join(crossStoreRoot, "evidence"));
	const guard = makeGuard(path.join(crossStoreRoot, "admission")); const authorization = guard.authorize("dispatch");
	const record = store.put({ value: { boundary: "report", state: "prepared" }, schemaVersionRef: "cross-store-v1", assetVersions: ["asset-v1"], participantProvenance: ["bootstrap/service"], retentionUntil: "2099-01-01T00:00:00.000Z" });
	assert.equal(guard.publish({ id: "cross-store-report", kind: "report", expectedSequence: authorization.sequence, evidenceHash: record.contentHash }).eligibility, "eligible");
	guard.applyIncident(report("cross-store-incident"));
	assert.equal(guard.snapshot().publications[0].eligibility, "TAINTED_OR_INVALIDATED");
	assert.equal(store.getByRef(record.retrievalRef, { schemaVersionRef: "cross-store-v1", assetVersions: ["asset-v1"], participantProvenance: ["bootstrap/service"] }).record.contentHash, record.contentHash);
	fs.rmSync(path.join(store.objectRoot, record.contentHash));
	assert.throws(() => store.getByRef(record.retrievalRef), /unavailable/);
} finally { fs.rmSync(crossStoreRoot, { recursive: true, force: true }); }

const baseRow = manifest.rows[0];
const slot = (overrides: Partial<NormalizedSlotResult> = {}): NormalizedSlotResult => ({ slotId: "S", itemId: "BOOT-X", itemVersion: 1, phase: "IMPLEMENT", datasetClass: "bootstrap", qualificationEligible: false, requested: structuredClone(baseRow.candidate), effective: structuredClone(baseRow.candidate), nonTargetRoutes: structuredClone(baseRow.nonTargetRoutes), judgeIdentity: structuredClone(baseRow.judge), isolation: { repository: "disposable://repo", piHome: "disposable://home", artifactRoot: "disposable://artifact", resultNamespace: "slot:S", processGroup: "isolated:S", credentialBoundary: "allowlisted-ephemeral", remotePolicy: "none" }, cleanupPassed: true, redactionPassed: true, status: "PASS", slotState: "JUDGED", deterministicPassed: true, qualitativeEligible: true, attempts: 2, infrastructureAttempts: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 2, childCostUsd: 2, outerCostUsd: 1, wallTimeMs: 200, firstPlannedPassCostUsd: 2, defaultFirstPlannedPassWallTimeMs: 100, minimumPlannedAttempts: 1, handoffs: ["a->b"], evidenceRefs: ["sha256:x"], ...overrides });
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
