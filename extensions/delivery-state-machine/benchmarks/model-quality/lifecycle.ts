import { hashObject, type DatasetItem } from "./schema.ts";

export type ContentState = DatasetItem["lifecycle"];
export type LifecycleActorRole = "llm-proposer" | "proposal-service" | "validator-service" | "authorized-human";
export interface LifecycleTransition {
	itemId: string;
	itemVersion: number;
	itemHash: string;
	priorState: ContentState;
	targetState: ContentState;
	actorId: string;
	actorRole: LifecycleActorRole;
	reason: string;
	timestamp: string;
	idempotencyKey: string;
	recordHash: string;
}

const ALLOWED: Partial<Record<ContentState, ContentState[]>> = {
	draft: ["proposed"],
	proposed: ["validated", "rejected"],
	validated: ["human_reviewed", "rejected"],
	human_reviewed: ["approved", "rejected"],
	approved: ["active", "rejected"],
	active: ["superseded", "retired"],
};
const HUMAN_ONLY = new Set<ContentState>(["human_reviewed", "approved", "active", "rejected", "superseded", "retired"]);

export function lifecycleRecord(input: Omit<LifecycleTransition, "recordHash">): LifecycleTransition {
	return { ...input, recordHash: hashObject(input) };
}

export function validateLifecycleTransition(value: LifecycleTransition): LifecycleTransition {
	const { recordHash: _, ...unsigned } = value;
	if (!/^[a-f0-9]{64}$/.test(value.itemHash) || value.recordHash !== hashObject(unsigned)) throw new Error("lifecycle transition hash is invalid");
	if (!ALLOWED[value.priorState]?.includes(value.targetState)) throw new Error(`invalid lifecycle transition: ${value.priorState} -> ${value.targetState}`);
	if (HUMAN_ONLY.has(value.targetState) && value.actorRole !== "authorized-human") throw new Error(`target state ${value.targetState} requires authorized-human intent`);
	if (value.actorRole === "llm-proposer" && value.targetState !== "proposed") throw new Error("LLMs may only propose lifecycle changes");
	if (!value.actorId || !value.reason || !value.idempotencyKey || !Number.isFinite(Date.parse(value.timestamp))) throw new Error("lifecycle transition provenance is incomplete");
	return value;
}
