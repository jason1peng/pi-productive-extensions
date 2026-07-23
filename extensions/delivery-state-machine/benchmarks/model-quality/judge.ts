import { randomBytes } from "node:crypto";
import { hashObject, validateJudgeRecord, type HumanReviewRecord, type JudgeRecord, type ModelIdentity, type Phase } from "./schema.ts";

export interface JudgePack {
	schemaVersion: 1;
	phase: Exclude<Phase, "CLOSE" | "E2E">;
	nonce: string;
	acceptedContract: string;
	deterministicEligibility: { eligible: true; summary: string; hash: string };
	outputs: { A: string; B: string };
	rubric: string;
	packHash: string;
}

const FORBIDDEN_KEYS = new Set(["identity", "identities", "cost", "latency", "transcript", "chainOfThought", "participant", "model"]);

export function assertJudgeIndependence(judges: ModelIdentity[], participants: ModelIdentity[]): void {
	const identities = (entry: ModelIdentity) => `${entry.provider}/${entry.model}@${entry.version}`;
	const seen = new Set<string>();
	for (const judge of judges) {
		const exact = identities(judge);
		if (seen.has(exact)) throw new Error("judges must be independent from each other");
		seen.add(exact);
		if (participants.some((participant) => identities(participant) === exact || (participant.provider === judge.provider && participant.family === judge.family))) throw new Error("judge collides with an evaluated participant");
	}
}

function rejectForbiddenKeys(value: unknown, trail = "pack"): void {
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(key)) throw new Error(`${trail}.${key} is forbidden in a judge pack`);
		rejectForbiddenKeys(nested, `${trail}.${key}`);
	}
}

export function buildJudgePack(input: { phase: Phase; acceptedContract: string; eligibleOutputA: string; eligibleOutputB: string; eligibilitySummary: string; rubric: string; swap?: boolean; nonce?: string }): JudgePack {
	if (input.phase === "CLOSE") throw new Error("CLOSE rejects default LLM judging");
	if (input.phase === "E2E") throw new Error("E2E final-patch judging belongs to qualification, not bootstrap infrastructure");
	for (const [field, value] of Object.entries({ acceptedContract: input.acceptedContract, eligibleOutputA: input.eligibleOutputA, eligibleOutputB: input.eligibleOutputB, eligibilitySummary: input.eligibilitySummary, rubric: input.rubric })) if (value.trim() === "") throw new Error(`${field} is required`);
	const swap = input.swap ?? (randomBytes(1)[0] % 2 === 1);
	const pack: Omit<JudgePack, "packHash"> = {
		schemaVersion: 1,
		phase: input.phase,
		nonce: input.nonce ?? randomBytes(16).toString("hex"),
		acceptedContract: input.acceptedContract,
		deterministicEligibility: { eligible: true, summary: input.eligibilitySummary, hash: hashObject(input.eligibilitySummary) },
		outputs: swap ? { A: input.eligibleOutputB, B: input.eligibleOutputA } : { A: input.eligibleOutputA, B: input.eligibleOutputB },
		rubric: input.rubric,
	};
	rejectForbiddenKeys(pack);
	return { ...pack, packHash: hashObject(pack) };
}

export function parseJudgeResponse(raw: string): JudgeRecord {
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { throw new Error("judge response must be one strict JSON object"); }
	return validateJudgeRecord(parsed);
}

export function blockerConfirmed(input: { reproduced: boolean; human?: HumanReviewRecord }): boolean {
	return input.reproduced || input.human?.decision === "confirmed" && input.human.actorRole === "authorized-human";
}
