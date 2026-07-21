import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceStore } from "./evidence.ts";
import { EvidenceAdmissionCoordinator } from "./admission-coordinator.ts";
import { SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST } from "./admission.ts";
import { buildJudgePack } from "./judge.ts";
import { loadBootstrapAssets, loadManifest, loadRegistry, resolveRows } from "./manifest.ts";
import { buildInfrastructureReport, type InfrastructureReport } from "./report.ts";
import { scorePhaseEvidence } from "./scorers/index.ts";
import { hashObject, validateHumanReview, validateSlotResult, type ManifestRow, type NormalizedSlotResult, type PhaseEvidence } from "./schema.ts";
import { validateStage7Sentinels } from "./stage7.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_REPORT = path.join(ROOT, "reports", "bootstrap-expected.json");

function fakeEvidence(row: ManifestRow): PhaseEvidence | undefined {
	if (row.phase === "E2E") return undefined;
	return {
		phase: row.phase,
		runtimeIdentityMatch: true,
		artifactValid: true,
		cleanupPassed: true,
		behaviorPassed: true,
		mutationPassed: true,
		gitPassed: true,
		knownOutcomeCorrect: ["VERIFY", "REVIEW"].includes(row.phase) ? true : undefined,
		readOnlyPassed: ["VERIFY", "REVIEW", "RETRO"].includes(row.phase) ? true : undefined,
		blockerSupported: row.phase === "REVIEW" ? true : undefined,
		falsePositive: row.phase === "REVIEW" ? false : undefined,
		evidenceBacked: row.phase === "RETRO" ? true : undefined,
		fabricationFree: row.phase === "RETRO" ? true : undefined,
		judgeRequested: false,
	};
}

function fakeSlot(row: ManifestRow, evidenceRef: string, admission: NormalizedSlotResult["admission"]): NormalizedSlotResult {
	const evidence = fakeEvidence(row);
	const deterministicPassed = evidence ? scorePhaseEvidence(evidence).passed : true;
	if (row.judge) buildJudgePack({ phase: row.phase, acceptedContract: `Bootstrap contract for ${row.phase}`, eligibleOutputA: "eligible output alpha", eligibleOutputB: "eligible output beta", eligibilitySummary: "all deterministic gates passed", rubric: `Supplemental ${row.phase} rubric`, swap: row.slotId.endsWith("2"), nonce: hashObject(row.slotId).slice(0, 32) });
	const handoffs = row.phase === "E2E" ? ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"] : [];
	return validateSlotResult({
		slotId: row.slotId, itemId: row.itemId, itemVersion: row.itemVersion, phase: row.phase, datasetClass: "bootstrap", qualificationEligible: false,
		requested: structuredClone(row.candidate), effective: structuredClone(row.candidate), nonTargetRoutes: structuredClone(row.nonTargetRoutes), ...(row.judge ? { judgeIdentity: structuredClone(row.judge) } : {}), judgeUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, wallTimeMs: 0 }, admission,
		isolation: { repository: `disposable://repository/${row.slotId}`, piHome: `disposable://pi-home/${row.slotId}`, artifactRoot: `disposable://artifact/${row.slotId}`, resultNamespace: `bootstrap:${row.slotId}`, processGroup: `isolated:${row.slotId}`, credentialBoundary: "allowlisted-ephemeral", remotePolicy: row.phase === "CLOSE" ? "local-stub" : "none" },
		cleanupPassed: true, redactionPassed: true,
		status: deterministicPassed ? "PASS" : "CANDIDATE_FAILURE", slotState: row.judge ? "JUDGED" : "NOT_ELIGIBLE_CANDIDATE", deterministicPassed,
		qualitativeEligible: Boolean(row.judge && deterministicPassed), attempts: row.minimumPlannedAttempts, infrastructureAttempts: 0,
		inputTokens: row.phase === "E2E" ? 50 : 10, outputTokens: row.phase === "E2E" ? 25 : 5, cachedTokens: 0,
		childCostUsd: 0, outerCostUsd: 0, wallTimeMs: row.phase === "E2E" ? 500 : 100, firstPlannedPassCostUsd: 0,
		defaultFirstPlannedPassWallTimeMs: row.phase === "E2E" ? 500 : 100, minimumPlannedAttempts: row.minimumPlannedAttempts,
		handoffs, evidenceRefs: [evidenceRef],
	}, row);
}

export function validateInfrastructure(): { items: number; rows: number; sentinels: number } {
	const registry = loadRegistry();
	const assets = loadBootstrapAssets(registry);
	const manifest = loadManifest();
	const resolved = resolveRows(manifest, registry);
	const scopes = new Set(resolved.map(({ row }) => row.phase));
	for (const phase of ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO", "E2E"]) if (!scopes.has(phase as any)) throw new Error(`bootstrap adapter is missing: ${phase}`);
	const stage7 = validateStage7Sentinels();
	for (const asset of assets.assets) for (const scenario of asset.stage7Scenarios) if (stage7.files[scenario.path] !== scenario.sha256) throw new Error(`bootstrap asset is not pinned to the Stage 7 sentinel: ${scenario.path}`);
	return { items: registry.items.length, rows: manifest.rows.length, sentinels: Object.keys(stage7.files).length };
}

export function fakeFull(generatedAt = "2026-07-21T04:00:00.000Z"): InfrastructureReport {
	validateInfrastructure();
	const manifest = loadManifest();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppe-001-fake-evidence-"));
	try {
		const store = new EvidenceStore(root);
		const record = store.put({ value: { kind: "bootstrap-fake", manifestHash: manifest.manifestHash, rawTranscript: "must not be retained", token: "synthetic-secret-12345678" }, schemaVersionRef: "model-quality-v1", assetVersions: ["bootstrap-registry-v1"], participantProvenance: ["fake/bootstrap-participant@v1"], retentionUntil: "2099-01-01T00:00:00.000Z", explicitSecrets: ["synthetic-secret-12345678"] });
		store.audit();
		const registry = new Map(loadRegistry().items.map((item) => [`${item.id}@${item.version}`, item]));
		const slots = manifest.rows.map((row) => {
			const item = registry.get(`${row.itemId}@${row.itemVersion}`)!; const coordinator = new EvidenceAdmissionCoordinator(path.join(root, "admission", row.slotId), store, { id: item.id, version: item.version, itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
			const selection = coordinator.authorize("selection"), dispatch = coordinator.authorize("dispatch"); const retentionUntil = "2099-01-01T00:00:00.000Z"; const publications: any[] = [];
			if (row.phase === "E2E") for (const [index, edge] of ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"].entries()) publications.push(coordinator.publish({ id: `${row.slotId}:join:${index + 1}`, publicationKind: "join", expectedSequence: dispatch.sequence, value: { edge }, schemaVersionRef: "model-quality-fake-admission-v1", assetVersions: [`manifest:${manifest.manifestHash}`], participantProvenance: ["fake/bootstrap-participant@v1"], retentionUntil }));
			publications.push(coordinator.publish({ id: `${row.slotId}:result-use`, publicationKind: "result-use", expectedSequence: dispatch.sequence, value: { slotId: row.slotId }, schemaVersionRef: "model-quality-fake-admission-v1", assetVersions: [`manifest:${manifest.manifestHash}`], participantProvenance: ["fake/bootstrap-participant@v1"], retentionUntil }));
			publications.push(coordinator.publish({ id: `${row.slotId}:report`, publicationKind: "report", expectedSequence: dispatch.sequence, value: { slotId: row.slotId, report: true }, schemaVersionRef: "model-quality-fake-admission-v1", assetVersions: [`manifest:${manifest.manifestHash}`], participantProvenance: ["fake/bootstrap-participant@v1"], retentionUntil }));
			return fakeSlot(row, record.retrievalRef, { itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash, selectionSequence: selection.sequence, dispatchSequence: dispatch.sequence, publications });
		});
		const report = buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots, generatedAt });
		validateHumanReview({ recordId: "BOOT-HUMAN-ROUNDTRIP", itemId: "BOOT-VERIFY", itemVersion: 1, resultHash: report.reportHash, decision: "pending", reason: "bootstrap human-record plumbing only", timestamp: generatedAt });
		return report;
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export function admissionRunnerProbe(order: "hold-first" | "publication-first", boundary: "result-use" | "join" | "report"): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppe-001-runner-admission-${order}-${boundary}-`));
	try {
		const store = new EvidenceStore(path.join(root, "evidence")); const manifest = loadManifest(), row = manifest.rows[0], item = loadRegistry().items.find((entry) => entry.id === row.itemId)!;
		const coordinator = new EvidenceAdmissionCoordinator(path.join(root, "admission"), store, { id: item.id, version: item.version, itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash }, SYNTHETIC_INCIDENT_POLICY, SYNTHETIC_SERVICE_ALLOWLIST);
		const selection = coordinator.authorize("selection"), dispatch = coordinator.authorize("dispatch"); const retentionUntil = "2099-01-01T00:00:00.000Z"; const refs = new Map<string, string>();
		const publish = (id: string, kind: "result-use" | "join" | "report") => { const value = coordinator.publish({ id, publicationKind: kind, expectedSequence: dispatch.sequence, value: { id, kind }, schemaVersionRef: "runner-probe-v1", assetVersions: [`manifest:${manifest.manifestHash}`], participantProvenance: ["fake/bootstrap-participant@v1"], retentionUntil }); refs.set(id, value.evidenceRef); return value; };
		const incident = () => coordinator.incident({ report: { idempotencyKey: `${order}-${boundary}`, itemId: item.id, itemVersion: item.version, itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash, reportClass: "credible-bootstrap-leakage", actorId: "bootstrap-incident-service" }, value: { credible: true }, schemaVersionRef: "runner-probe-incident-v1", assetVersions: [`manifest:${manifest.manifestHash}`], participantProvenance: ["bootstrap-incident-service"], retentionUntil });
		if (order === "hold-first") { incident(); publish("probe-boundary", boundary); } else { publish("probe-boundary", boundary); incident(); }
		publish("probe-result", "result-use"); publish("probe-report", "report");
		const publications = (coordinator.snapshot() as any).publications.map((entry: any) => ({ ...entry, evidenceRef: refs.get(entry.id) }));
		const slot = fakeSlot(row, refs.get("probe-result")!, { itemHash: item.publicAssetHash, catalogHash: manifest.manifestHash, selectionSequence: selection.sequence, dispatchSequence: dispatch.sequence, publications });
		buildInfrastructureReport({ manifestHash: manifest.manifestHash, slots: [slot] });
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export function auditCleanClone(): { reportHash: string; gitClean: boolean } {
	const report = fakeFull();
	const expected = JSON.parse(fs.readFileSync(EXPECTED_REPORT, "utf8")) as InfrastructureReport;
	if (expected.reportHash !== report.reportHash || JSON.stringify(expected) !== JSON.stringify(report)) throw new Error("clean-clone bootstrap report does not reproduce");
	const repository = path.resolve(ROOT, "../../../..");
	const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: repository, encoding: "utf8" }).trim();
	return { reportHash: report.reportHash, gitClean: status === "" };
}

if (import.meta.main) {
	const command = process.argv[2] ?? "validate";
	try {
		if (command === "validate") console.log(JSON.stringify(validateInfrastructure(), null, 2));
		else if (command === "fake-full") console.log(JSON.stringify(fakeFull(), null, 2));
		else if (command === "audit") console.log(JSON.stringify(auditCleanClone(), null, 2));
		else if (command === "bootstrap-canary" || command === "bootstrap-e2e") {
			const { runRealCanary } = await import("./canary.ts");
			console.log(JSON.stringify(await runRealCanary(command === "bootstrap-e2e" ? "e2e" : "all"), null, 2));
		}
		else if (command === "audit-real") {
			const { auditRealCanary } = await import("./canary.ts");
			console.log(JSON.stringify(auditRealCanary(), null, 2));
		}
		else throw new Error(`unknown model-quality command: ${command}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
