import type { SlotState } from "./schema.ts";

export type AttemptClassification = "PASS" | "CANDIDATE_FAILURE" | "INFRASTRUCTURE_FAILURE";
export interface AttemptRecord { slotId: string; attempt: number; classification: AttemptClassification; evidenceRef: string }
export interface BoundedOutcome { slotId: string; slotState: SlotState; attempts: AttemptRecord[]; scoredClassification?: Exclude<AttemptClassification, "INFRASTRUCTURE_FAILURE"> }

export function boundedOutcome(slotId: string, maxInfrastructureAttempts: number, execute: (attempt: number) => Omit<AttemptRecord, "slotId" | "attempt">): BoundedOutcome {
	if (!Number.isInteger(maxInfrastructureAttempts) || maxInfrastructureAttempts < 1) throw new Error("maxInfrastructureAttempts must be positive");
	const attempts: AttemptRecord[] = [];
	for (let attempt = 1; attempt <= maxInfrastructureAttempts; attempt++) {
		const result = execute(attempt);
		if (!result.evidenceRef) throw new Error("every attempt must retain an evidence reference");
		const record: AttemptRecord = { slotId, attempt, ...result };
		attempts.push(record);
		if (record.classification !== "INFRASTRUCTURE_FAILURE") return { slotId, slotState: record.classification === "PASS" ? "JUDGED" : "NOT_ELIGIBLE_CANDIDATE", attempts, scoredClassification: record.classification };
	}
	return { slotId, slotState: "INFRASTRUCTURE_EXHAUSTED", attempts };
}

export function qualitativeDenominator(outcomes: BoundedOutcome[]): { frozenSlots: number; judged: number; excluded: Record<SlotState, number> } {
	const excluded = { JUDGED: 0, NOT_ELIGIBLE_CANDIDATE: 0, INCONCLUSIVE_BASELINE: 0, INCONCLUSIVE_EVALUATOR: 0, INFRASTRUCTURE_EXHAUSTED: 0 } satisfies Record<SlotState, number>;
	for (const outcome of outcomes) excluded[outcome.slotState] += 1;
	return { frozenSlots: outcomes.length, judged: excluded.JUDGED, excluded };
}
