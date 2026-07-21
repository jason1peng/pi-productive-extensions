import { createHash } from "node:crypto";

export const MODEL_QUALITY_SCHEMA_VERSION = 1 as const;
export const DATASET_CLASSES = ["bootstrap", "golden", "calibration"] as const;
export const PHASES = ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO", "E2E"] as const;
export type DatasetClass = typeof DATASET_CLASSES[number];
export type Phase = typeof PHASES[number];
export type HumanDecision = "confirmed" | "rejected" | "pending" | "abstained";
export type SlotState = "JUDGED" | "NOT_ELIGIBLE_CANDIDATE" | "INCONCLUSIVE_BASELINE" | "INCONCLUSIVE_EVALUATOR" | "INFRASTRUCTURE_EXHAUSTED";

export interface ModelIdentity {
	provider: string;
	model: string;
	version: string;
	family: string;
}

export interface DatasetItem {
	schemaVersion: typeof MODEL_QUALITY_SCHEMA_VERSION;
	id: string;
	version: number;
	datasetClass: DatasetClass;
	qualificationEligible: boolean;
	scope: Phase;
	tags: string[];
	lifecycle: "draft" | "proposed" | "validated" | "human_reviewed" | "approved" | "active" | "rejected" | "superseded" | "retired";
	admissionState: "admitted" | "quarantined";
	holdState: "clear" | "pending";
	executionPromptVersion: string;
	scenarioVersion: string;
	oracleVersion: string;
	judgeRubricVersion: string;
	publicAssetHash: string;
	restrictedOracleHash: string;
	fixtureHash: string;
	scorerVersion: string;
	provenance: string;
	approvalRecordRefs: string[];
	cleanRoomExportPolicy: string;
}

export interface ManifestRow {
	slotId: string;
	itemId: string;
	itemVersion: number;
	phase: Phase;
	datasetClass: DatasetClass;
	qualificationEligible: boolean;
	candidate: ModelIdentity & { agent: string; promptVersion: string; toolsHash: string; thinking: string; context: string };
	nonTargetRoutes: Record<string, string>;
	judge?: ModelIdentity & { rubricVersion: string };
	maxInfrastructureAttempts: number;
	budgetUsd: number;
	minimumPlannedAttempts: number;
}

export interface SparseManifest {
	schemaVersion: typeof MODEL_QUALITY_SCHEMA_VERSION;
	id: string;
	version: number;
	frozenAt: string;
	manifestHash: string;
	expectedRows: number;
	maxRows: number;
	maxCostUsd: number;
	serial: true;
	rows: ManifestRow[];
}

export interface HumanReviewRecord {
	recordId: string;
	itemId: string;
	itemVersion: number;
	resultHash: string;
	decision: HumanDecision;
	actorId?: string;
	actorRole?: "authorized-human";
	reason: string;
	timestamp: string;
}

export interface JudgeRecord {
	verdict: "A" | "B" | "TIE" | "ABSTAIN";
	confidence: number;
	citations: string[];
	limitations: string[];
	error?: { code: string; message: string };
}

export interface PhaseEvidence {
	phase: Exclude<Phase, "E2E">;
	runtimeIdentityMatch: boolean;
	artifactValid: boolean;
	cleanupPassed: boolean;
	behaviorPassed: boolean;
	mutationPassed: boolean;
	gitPassed: boolean;
	knownOutcomeCorrect?: boolean;
	readOnlyPassed?: boolean;
	blockerSupported?: boolean;
	falsePositive?: boolean;
	evidenceBacked?: boolean;
	fabricationFree?: boolean;
	judgeRequested?: boolean;
}

export interface NormalizedSlotResult {
	slotId: string;
	itemId: string;
	itemVersion: number;
	phase: Phase;
	datasetClass: DatasetClass;
	qualificationEligible: boolean;
	requested: ManifestRow["candidate"];
	effective: ManifestRow["candidate"];
	nonTargetRoutes: Record<string, string>;
	judgeIdentity?: ManifestRow["judge"];
	isolation: { repository: string; piHome: string; artifactRoot: string; resultNamespace: string; processGroup: string; credentialBoundary: "allowlisted-ephemeral"; remotePolicy: "none" | "local-stub" };
	cleanupPassed: boolean;
	redactionPassed: boolean;
	status: "PASS" | "CANDIDATE_FAILURE" | "INFRASTRUCTURE_FAILURE" | "TAINTED_OR_INVALIDATED";
	slotState: SlotState;
	deterministicPassed: boolean;
	qualitativeEligible: boolean;
	attempts: number;
	infrastructureAttempts: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	childCostUsd: number;
	outerCostUsd: number;
	wallTimeMs: number;
	firstPlannedPassCostUsd: number;
	defaultFirstPlannedPassWallTimeMs: number;
	minimumPlannedAttempts: number;
	handoffs: string[];
	evidenceRefs: string[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Z][A-Z0-9-]{2,63}$/;

function object(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value;
}
function integer(value: unknown, field: string, minimum = 0): number {
	if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${field} must be an integer >= ${minimum}`);
	return Number(value);
}
function number(value: unknown, field: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${field} must be a finite number >= ${minimum}`);
	return value;
}
function bool(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
	return value;
}
function enumValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
	if (!allowed.includes(String(value))) throw new Error(`${field} is invalid`);
	return value as T[number];
}
function hash(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be a lowercase SHA-256`);
	return value;
}
function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value.map((entry, index) => string(entry, `${field}[${index}]`));
}
function exactKeys(value: Record<string, unknown>, field: string, required: string[], optional: string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	const missing = required.filter((key) => !(key in value));
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (missing.length) throw new Error(`${field} missing: ${missing.join(", ")}`);
	if (unknown.length) throw new Error(`${field} unknown: ${unknown.join(", ")}`);
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
	return JSON.stringify(value);
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function hashObject(value: unknown): string { return sha256(canonicalJson(value)); }

export function validateIdentity(value: unknown, field: string): ModelIdentity {
	const row = object(value, field);
	for (const key of ["provider", "model", "version", "family"]) string(row[key], `${field}.${key}`);
	return row as unknown as ModelIdentity;
}

export function validateDatasetItem(value: unknown): DatasetItem {
	const row = object(value, "dataset item");
	exactKeys(row, "dataset item", ["schemaVersion", "id", "version", "datasetClass", "qualificationEligible", "scope", "tags", "lifecycle", "admissionState", "holdState", "executionPromptVersion", "scenarioVersion", "oracleVersion", "judgeRubricVersion", "publicAssetHash", "restrictedOracleHash", "fixtureHash", "scorerVersion", "provenance", "approvalRecordRefs", "cleanRoomExportPolicy"]);
	if (row.schemaVersion !== MODEL_QUALITY_SCHEMA_VERSION) throw new Error("unsupported dataset schemaVersion");
	if (!SAFE_ID.test(string(row.id, "id"))) throw new Error("dataset id is invalid");
	integer(row.version, "version", 1);
	const datasetClass = enumValue(row.datasetClass, DATASET_CLASSES, "datasetClass");
	const eligible = bool(row.qualificationEligible, "qualificationEligible");
	if (datasetClass === "bootstrap" && eligible) throw new Error("bootstrap items are permanently qualification-ineligible");
	if (String(row.id).startsWith("BOOT-") && datasetClass !== "bootstrap") throw new Error("an immutable bootstrap item/version cannot be relabeled");
	enumValue(row.scope, PHASES, "scope");
	strings(row.tags, "tags");
	enumValue(row.lifecycle, ["draft", "proposed", "validated", "human_reviewed", "approved", "active", "rejected", "superseded", "retired"] as const, "lifecycle");
	enumValue(row.admissionState, ["admitted", "quarantined"] as const, "admissionState");
	enumValue(row.holdState, ["clear", "pending"] as const, "holdState");
	for (const key of ["executionPromptVersion", "scenarioVersion", "oracleVersion", "judgeRubricVersion", "scorerVersion", "provenance", "cleanRoomExportPolicy"]) string(row[key], key);
	for (const key of ["publicAssetHash", "restrictedOracleHash", "fixtureHash"]) hash(row[key], key);
	strings(row.approvalRecordRefs, "approvalRecordRefs");
	return row as unknown as DatasetItem;
}

function validateManifestRow(value: unknown, index: number): ManifestRow {
	const row = object(value, `rows[${index}]`);
	exactKeys(row, `rows[${index}]`, ["slotId", "itemId", "itemVersion", "phase", "datasetClass", "qualificationEligible", "candidate", "nonTargetRoutes", "maxInfrastructureAttempts", "budgetUsd", "minimumPlannedAttempts"], ["judge"]);
	string(row.slotId, `rows[${index}].slotId`);
	string(row.itemId, `rows[${index}].itemId`);
	integer(row.itemVersion, `rows[${index}].itemVersion`, 1);
	enumValue(row.phase, PHASES, `rows[${index}].phase`);
	const datasetClass = enumValue(row.datasetClass, DATASET_CLASSES, `rows[${index}].datasetClass`);
	const eligible = bool(row.qualificationEligible, `rows[${index}].qualificationEligible`);
	if (datasetClass === "bootstrap" && eligible) throw new Error("bootstrap manifest rows are permanently qualification-ineligible");
	if (String(row.itemId).startsWith("BOOT-") && datasetClass !== "bootstrap") throw new Error("an immutable bootstrap manifest row cannot be relabeled");
	const candidate = object(row.candidate, `rows[${index}].candidate`);
	validateIdentity(candidate, `rows[${index}].candidate`);
	for (const key of ["agent", "promptVersion", "toolsHash", "thinking", "context"]) string(candidate[key], `rows[${index}].candidate.${key}`);
	hash(candidate.toolsHash, `rows[${index}].candidate.toolsHash`);
	const routes = object(row.nonTargetRoutes, `rows[${index}].nonTargetRoutes`);
	for (const [key, route] of Object.entries(routes)) { string(key, "route key"); string(route, `route ${key}`); }
	if (row.judge !== undefined) {
		const judge = object(row.judge, `rows[${index}].judge`);
		validateIdentity(judge, `rows[${index}].judge`);
		string(judge.rubricVersion, `rows[${index}].judge.rubricVersion`);
	}
	integer(row.maxInfrastructureAttempts, `rows[${index}].maxInfrastructureAttempts`, 1);
	number(row.budgetUsd, `rows[${index}].budgetUsd`);
	integer(row.minimumPlannedAttempts, `rows[${index}].minimumPlannedAttempts`, 1);
	return row as unknown as ManifestRow;
}

export function manifestContent(value: SparseManifest): Omit<SparseManifest, "manifestHash"> {
	const { manifestHash: _, ...content } = value;
	return content;
}
export function validateManifest(value: unknown): SparseManifest {
	const row = object(value, "manifest");
	exactKeys(row, "manifest", ["schemaVersion", "id", "version", "frozenAt", "manifestHash", "expectedRows", "maxRows", "maxCostUsd", "serial", "rows"]);
	if (row.schemaVersion !== MODEL_QUALITY_SCHEMA_VERSION) throw new Error("unsupported manifest schemaVersion");
	string(row.id, "manifest.id"); integer(row.version, "manifest.version", 1);
	if (typeof row.frozenAt !== "string" || !Number.isFinite(Date.parse(row.frozenAt))) throw new Error("manifest.frozenAt must be ISO-8601");
	hash(row.manifestHash, "manifest.manifestHash");
	integer(row.expectedRows, "manifest.expectedRows", 1); integer(row.maxRows, "manifest.maxRows", 1); number(row.maxCostUsd, "manifest.maxCostUsd");
	if (row.serial !== true) throw new Error("bootstrap manifests must remain serial until isolation is independently proven");
	if (!Array.isArray(row.rows)) throw new Error("manifest.rows must be an explicit array");
	if ("candidates" in row || "scenarios" in row || "matrix" in row) throw new Error("implicit Cartesian manifest expansion is forbidden");
	const rows = row.rows.map(validateManifestRow);
	if (rows.length !== row.expectedRows || rows.length > Number(row.maxRows)) throw new Error("manifest row count differs from frozen bounds");
	if (rows.reduce((sum, entry) => sum + entry.budgetUsd, 0) > Number(row.maxCostUsd) + Number.EPSILON) throw new Error("manifest exceeds frozen cost ceiling");
	const slots = new Set<string>();
	for (const entry of rows) {
		if (slots.has(entry.slotId)) throw new Error(`duplicate slot id: ${entry.slotId}`);
		slots.add(entry.slotId);
		if (entry.judge) {
			const participants = [entry.candidate, ...Object.values(entry.nonTargetRoutes).map((identity) => ({ provider: identity.split("/")[0], model: identity.split("/").slice(1).join("/"), version: "route", family: identity }))];
			if (participants.some((participant) => participant.provider === entry.judge!.provider && (participant.model === entry.judge!.model || participant.family === entry.judge!.family))) throw new Error(`judge identity collision in ${entry.slotId}`);
		}
		if (entry.phase === "CLOSE" && entry.judge) throw new Error("CLOSE does not admit a default judge");
	}
	const manifest = row as unknown as SparseManifest;
	if (hashObject(manifestContent(manifest)) !== manifest.manifestHash) throw new Error("manifest hash does not match frozen content");
	return manifest;
}

export function validateHumanReview(value: unknown): HumanReviewRecord {
	const row = object(value, "human review");
	exactKeys(row, "human review", ["recordId", "itemId", "itemVersion", "resultHash", "decision", "reason", "timestamp"], ["actorId", "actorRole"]);
	string(row.recordId, "recordId"); string(row.itemId, "itemId"); integer(row.itemVersion, "itemVersion", 1); hash(row.resultHash, "resultHash");
	const decision = enumValue(row.decision, ["confirmed", "rejected", "pending", "abstained"] as const, "decision");
	string(row.reason, "reason");
	if (typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) throw new Error("timestamp is invalid");
	if (decision === "confirmed" || decision === "rejected") {
		string(row.actorId, "actorId");
		if (row.actorRole !== "authorized-human") throw new Error("affirmative human decisions require authorized-human role");
	}
	return row as unknown as HumanReviewRecord;
}

export function validateJudgeRecord(value: unknown): JudgeRecord {
	const row = object(value, "judge record");
	exactKeys(row, "judge record", ["verdict", "confidence", "citations", "limitations"], ["error"]);
	enumValue(row.verdict, ["A", "B", "TIE", "ABSTAIN"] as const, "verdict");
	const confidence = number(row.confidence, "confidence"); if (confidence > 1) throw new Error("confidence must be <= 1");
	strings(row.citations, "citations"); strings(row.limitations, "limitations");
	if (row.error !== undefined) { const error = object(row.error, "error"); exactKeys(error, "error", ["code", "message"]); string(error.code, "error.code"); string(error.message, "error.message"); }
	return row as unknown as JudgeRecord;
}

export function validateSlotResult(value: NormalizedSlotResult, row: ManifestRow): NormalizedSlotResult {
	if (value.slotId !== row.slotId || value.itemId !== row.itemId || value.itemVersion !== row.itemVersion || value.phase !== row.phase) throw new Error("normalized slot identity differs from the frozen manifest");
	assertBootstrapNonQualification(value, "runner");
	if (canonicalJson(value.requested) !== canonicalJson(row.candidate) || canonicalJson(value.effective) !== canonicalJson(row.candidate)) throw new Error("requested/effective runtime identity or settings mismatch");
	if (canonicalJson(value.nonTargetRoutes) !== canonicalJson(row.nonTargetRoutes)) throw new Error("non-target route identity mismatch");
	if (canonicalJson(value.judgeIdentity) !== canonicalJson(row.judge)) throw new Error("judge identity mismatch");
	if (value.attempts < row.minimumPlannedAttempts) throw new Error("attempt denominator is below the mandatory route count");
	if (value.infrastructureAttempts > row.maxInfrastructureAttempts - 1 || value.attempts > row.minimumPlannedAttempts + row.maxInfrastructureAttempts - 1) throw new Error("row-wide infrastructure retry bound exceeded");
	for (const [key, nested] of Object.entries(value.isolation)) string(nested, `isolation.${key}`);
	if (!value.cleanupPassed) throw new Error("cleanup failure is unscored infrastructure");
	if (!value.redactionPassed) throw new Error("redaction failure is unscored infrastructure");
	if (value.phase === "E2E") {
		const expected = ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"];
		if (canonicalJson(value.handoffs) !== canonicalJson(expected)) throw new Error("E2E changed-route handoffs are incomplete");
	}
	return value;
}

export function assertBootstrapNonQualification(value: { datasetClass: DatasetClass; qualificationEligible: boolean }, boundary: "schema" | "runner" | "report" | "adoption"): void {
	if (value.datasetClass === "bootstrap" && value.qualificationEligible) throw new Error(`${boundary}: bootstrap qualification is permanently forbidden`);
}

export function canModelBlockDeterministicPass(input: { phase: Phase; deterministicPassed: boolean; reproduced: boolean; human?: HumanReviewRecord }): boolean {
	if (!input.deterministicPassed || !["VERIFY", "REVIEW"].includes(input.phase)) return false;
	if (input.reproduced) return true;
	return input.human?.decision === "confirmed" && input.human.actorRole === "authorized-human";
}
