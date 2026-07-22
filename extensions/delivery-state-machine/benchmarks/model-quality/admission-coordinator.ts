import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AdmissionGuard, SYNTHETIC_HUMAN_AUTHORIZER, type HumanAuthorizer, type IncidentPolicy, type IncidentReport } from "./admission.ts";
import { EvidenceStore, assertRedacted, redactValue, type EvidenceIndexRecord } from "./evidence.ts";
import { hashObject } from "./schema.ts";

export type PublicationKind = "result-use" | "join" | "report";
export interface CoordinatedPublication {
	id: string; kind: PublicationKind; sequence: number; eligibility: "eligible" | "TAINTED_OR_INVALIDATED"; evidenceHash: string; evidenceRef: string;
}
interface BaseJournal {
	schemaVersion: 1; operationId: string; state: "prepared" | "evidence-retained" | "guard-committed"; evidence?: EvidenceIndexRecord;
}
interface PublicationJournal extends BaseJournal {
	kind: "publication";
	input: { id: string; publicationKind: PublicationKind; expectedSequence: number; value: unknown; schemaVersionRef: string; assetVersions: string[]; participantProvenance: string[]; retentionUntil: string };
	publication?: CoordinatedPublication;
}
interface IncidentJournal extends BaseJournal {
	kind: "incident";
	input: { report: Omit<IncidentReport, "evidenceHash">; value: unknown; schemaVersionRef: string; assetVersions: string[]; participantProvenance: string[]; retentionUntil: string };
	ack?: { acknowledged: boolean; sequence: number };
}
type Journal = PublicationJournal | IncidentJournal;
export type CoordinatorFault = "after-prepare" | "after-evidence" | "after-guard";

function atomicJson(file: string, value: unknown): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/**
 * Coordinates the content-addressed store with AdmissionGuard. The journal is
 * durable before either side changes; replay is idempotent and fail-closed.
 */
export class EvidenceAdmissionCoordinator {
	readonly guard: AdmissionGuard;
	readonly journalRoot: string;
	constructor(readonly root: string, readonly store: EvidenceStore, item: { id: string; version: number; itemHash: string; catalogHash: string }, policy: IncidentPolicy, serviceAllowlist: ReadonlySet<string>, humanAuthorizer: HumanAuthorizer = SYNTHETIC_HUMAN_AUTHORIZER) {
		this.journalRoot = path.join(root, "coordinator-journal");
		fs.mkdirSync(this.journalRoot, { recursive: true });
		this.guard = new AdmissionGuard(path.join(root, "guard"), item, policy, serviceAllowlist, humanAuthorizer, (hash) => store.hasContentHash(hash));
		this.reconcile();
	}
	authorize(boundary: "selection" | "dispatch") { return this.guard.authorize(boundary); }
	private journalFile(operationId: string): string { return path.join(this.journalRoot, `${hashObject(operationId)}.json`); }
	private write(journal: Journal): void { atomicJson(this.journalFile(journal.operationId), journal); }
	private maybeFault(fault: CoordinatorFault | undefined, point: CoordinatorFault): void { if (fault === point) throw new Error(`simulated coordinator crash ${point}`); }
	private evidenceFor(journal: Journal, explicitSecrets: string[] = []): EvidenceIndexRecord {
		if (journal.evidence) return this.store.getByRef(journal.evidence.retrievalRef, { schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance }).record;
		const record = this.store.put({ value: journal.input.value, schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance, retentionUntil: journal.input.retentionUntil, explicitSecrets, indexId: `coordinator:${journal.operationId}` });
		journal.evidence = record; journal.state = "evidence-retained"; this.write(journal);
		return record;
	}
	private finishPublication(journal: PublicationJournal): CoordinatedPublication {
		const evidence = this.evidenceFor(journal);
		if (!journal.publication) {
			const published = this.guard.publish({ id: journal.input.id, kind: journal.input.publicationKind, expectedSequence: journal.input.expectedSequence, evidenceHash: evidence.contentHash });
			journal.publication = { ...published, evidenceRef: evidence.retrievalRef };
			journal.state = "guard-committed"; this.write(journal);
		}
		this.store.getByRef(journal.publication.evidenceRef, { schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance });
		fs.rmSync(this.journalFile(journal.operationId), { force: true });
		return structuredClone(journal.publication);
	}
	private finishIncident(journal: IncidentJournal): { acknowledged: boolean; sequence: number; evidenceRef: string } {
		const evidence = this.evidenceFor(journal);
		if (!journal.ack) {
			const result = this.guard.applyIncident({ ...journal.input.report, evidenceHash: evidence.contentHash });
			journal.ack = { acknowledged: result.acknowledged, sequence: result.sequence };
			journal.state = "guard-committed"; this.write(journal);
		}
		this.store.getByRef(evidence.retrievalRef, { schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance });
		fs.rmSync(this.journalFile(journal.operationId), { force: true });
		return { ...journal.ack, evidenceRef: evidence.retrievalRef };
	}
	publish(input: PublicationJournal["input"], faultAfter?: CoordinatorFault, explicitSecrets: string[] = []): CoordinatedPublication {
		const meaningful = [...new Set(explicitSecrets.filter((value) => value.length >= 8))];
		const original = JSON.stringify(input.value);
		if (meaningful.some((secret) => original.includes(secret))) throw new Error("credential material required redaction before evidence publication");
		const safeValue = redactValue(input.value, meaningful); assertRedacted(safeValue, meaningful);
		const safeInput: PublicationJournal["input"] = { ...input, value: safeValue };
		const operationId = `publication:${safeInput.id}`; const file = this.journalFile(operationId);
		const journal: PublicationJournal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1, operationId, kind: "publication", state: "prepared", input: safeInput };
		if (!fs.existsSync(file)) this.write(journal);
		this.maybeFault(faultAfter, "after-prepare");
		this.evidenceFor(journal, meaningful); this.maybeFault(faultAfter, "after-evidence");
		const publication = this.finishPublicationWithoutDelete(journal); this.maybeFault(faultAfter, "after-guard");
		fs.rmSync(file, { force: true }); return publication;
	}
	private finishPublicationWithoutDelete(journal: PublicationJournal): CoordinatedPublication {
		const evidence = this.evidenceFor(journal);
		if (!journal.publication) {
			const published = this.guard.publish({ id: journal.input.id, kind: journal.input.publicationKind, expectedSequence: journal.input.expectedSequence, evidenceHash: evidence.contentHash });
			journal.publication = { ...published, evidenceRef: evidence.retrievalRef }; journal.state = "guard-committed"; this.write(journal);
		}
		return structuredClone(journal.publication);
	}
	incident(input: IncidentJournal["input"], faultAfter?: CoordinatorFault): { acknowledged: boolean; sequence: number; evidenceRef: string } {
		const operationId = `incident:${input.report.idempotencyKey}`; const file = this.journalFile(operationId);
		const journal: IncidentJournal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1, operationId, kind: "incident", state: "prepared", input };
		if (!fs.existsSync(file)) this.write(journal);
		this.maybeFault(faultAfter, "after-prepare"); this.evidenceFor(journal); this.maybeFault(faultAfter, "after-evidence");
		const evidence = journal.evidence!;
		if (!journal.ack) { const result = this.guard.applyIncident({ ...input.report, evidenceHash: evidence.contentHash }); journal.ack = { acknowledged: result.acknowledged, sequence: result.sequence }; journal.state = "guard-committed"; this.write(journal); }
		this.maybeFault(faultAfter, "after-guard"); fs.rmSync(file, { force: true }); return { ...journal.ack, evidenceRef: evidence.retrievalRef };
	}
	reconcile(): void {
		for (const file of fs.readdirSync(this.journalRoot).filter((entry) => entry.endsWith(".json"))) {
			const journal = JSON.parse(fs.readFileSync(path.join(this.journalRoot, file), "utf8")) as Journal;
			if (journal.schemaVersion !== 1 || !journal.operationId) throw new Error("fail-closed: coordinator journal is invalid");
			if (journal.kind === "publication") this.finishPublication(journal); else this.finishIncident(journal);
		}
	}
	snapshot() { this.reconcile(); return this.guard.snapshot(); }
}
