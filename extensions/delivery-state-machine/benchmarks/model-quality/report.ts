import { assertBootstrapNonQualification, hashObject, type NormalizedSlotResult } from "./schema.ts";

export const INFRASTRUCTURE_BANNER = "INFRASTRUCTURE_ONLY — NOT QUALIFICATION EVIDENCE" as const;

export interface JoinedMetrics {
	slots: number;
	passed: number;
	candidateFailures: number;
	infrastructureExhausted: number;
	tainted: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	childCostUsd: number;
	outerCostUsd: number;
	totalCostUsd: number;
	wallTimeMs: number;
	repairAmplification: number | null;
	costAmplification: number | null;
	latencyAmplification: number | null;
	reliability: number;
	handoffCount: number;
}
export interface InfrastructureReport {
	schemaVersion: 1;
	classification: typeof INFRASTRUCTURE_BANNER;
	datasetClass: "bootstrap";
	qualificationEligible: false;
	manifestHash: string;
	generatedAt: string;
	metrics: JoinedMetrics;
	slots: NormalizedSlotResult[];
	evidenceRefs: string[];
	reportHash: string;
}

function ratio(numerator: number, denominator: number): number | null { return denominator > 0 ? numerator / denominator : null; }

export function joinedMetrics(slots: NormalizedSlotResult[]): JoinedMetrics {
	const attempts = slots.reduce((sum, slot) => sum + Math.max(0, slot.attempts - slot.infrastructureAttempts), 0);
	const minimum = slots.reduce((sum, slot) => sum + slot.minimumPlannedAttempts, 0);
	const actualCost = slots.reduce((sum, slot) => sum + slot.childCostUsd + slot.outerCostUsd, 0);
	const firstCost = slots.reduce((sum, slot) => sum + slot.firstPlannedPassCostUsd, 0);
	const wallTime = slots.reduce((sum, slot) => sum + slot.wallTimeMs, 0);
	const comparableDefault = slots.reduce((sum, slot) => sum + slot.defaultFirstPlannedPassWallTimeMs, 0);
	const scored = slots.filter((slot) => slot.status !== "INFRASTRUCTURE_FAILURE").length;
	return {
		slots: slots.length,
		passed: slots.filter((slot) => slot.status === "PASS").length,
		candidateFailures: slots.filter((slot) => slot.status === "CANDIDATE_FAILURE").length,
		infrastructureExhausted: slots.filter((slot) => slot.status === "INFRASTRUCTURE_FAILURE").length,
		tainted: slots.filter((slot) => slot.status === "TAINTED_OR_INVALIDATED").length,
		inputTokens: slots.reduce((sum, slot) => sum + slot.inputTokens, 0),
		outputTokens: slots.reduce((sum, slot) => sum + slot.outputTokens, 0),
		cachedTokens: slots.reduce((sum, slot) => sum + slot.cachedTokens, 0),
		childCostUsd: slots.reduce((sum, slot) => sum + slot.childCostUsd, 0),
		outerCostUsd: slots.reduce((sum, slot) => sum + slot.outerCostUsd, 0),
		totalCostUsd: actualCost,
		wallTimeMs: wallTime,
		repairAmplification: ratio(attempts, minimum),
		costAmplification: ratio(actualCost, firstCost),
		latencyAmplification: ratio(wallTime, comparableDefault),
		reliability: ratio(slots.filter((slot) => slot.status === "PASS").length, scored) ?? 0,
		handoffCount: slots.reduce((sum, slot) => sum + slot.handoffs.length, 0),
	};
}

export function buildInfrastructureReport(input: { manifestHash: string; slots: NormalizedSlotResult[]; generatedAt?: string }): InfrastructureReport {
	for (const slot of input.slots) {
		assertBootstrapNonQualification(slot, "report");
		if (slot.admission.catalogHash !== input.manifestHash || !slot.admission.publications.some((entry) => entry.kind === "result-use") || !slot.admission.publications.some((entry) => entry.kind === "report") || slot.admission.publications.some((entry) => entry.eligibility !== "eligible")) throw new Error("report publication is not authorized by the linearizable admission guard");
		if (slot.phase === "E2E" && slot.admission.publications.filter((entry) => entry.kind === "join").length !== 4) throw new Error("report E2E join publications are not admission-authorized");
	}
	const report: Omit<InfrastructureReport, "reportHash"> = { schemaVersion: 1, classification: INFRASTRUCTURE_BANNER, datasetClass: "bootstrap", qualificationEligible: false, manifestHash: input.manifestHash, generatedAt: input.generatedAt ?? new Date().toISOString(), metrics: joinedMetrics(input.slots), slots: input.slots, evidenceRefs: [...new Set(input.slots.flatMap((slot) => slot.evidenceRefs))] };
	return { ...report, reportHash: hashObject(report) };
}

export function adoptionDecision(report: InfrastructureReport): never {
	assertBootstrapNonQualification(report, "adoption");
	throw new Error("adoption: bootstrap reports can never emit qualification, support, routing, or adoption decisions");
}
