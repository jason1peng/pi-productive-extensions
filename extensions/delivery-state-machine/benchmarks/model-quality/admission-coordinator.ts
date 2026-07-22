import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AdmissionGuard, SYNTHETIC_HUMAN_AUTHORIZER, type HumanAuthorizer, type IncidentPolicy, type IncidentReport } from "./admission.ts";
import { EvidenceStore, assertRedacted, redactValue, type EvidenceIndexRecord } from "./evidence.ts";
import { OwnedFileLock, type OwnedLockHooks, type OwnedLockRecord } from "./owned-lock.ts";
import { hashObject } from "./schema.ts";

export type PublicationKind = "result-use" | "join" | "report";
export interface CoordinatedPublication {
	id: string; kind: PublicationKind; sequence: number; eligibility: "eligible" | "TAINTED_OR_INVALIDATED"; evidenceHash: string; evidenceRef: string;
}
interface BaseJournal {
	schemaVersion: 3; coordinatorNamespace: string; operationId: string; state: "prepared" | "evidence-retained" | "guard-committed"; inputHash: string; journalHash: string; evidence?: EvidenceIndexRecord;
}
interface CoordinatorItem { id: string; version: number; itemHash: string; catalogHash: string; coordinatorScope?: string }
interface CoordinatorNamespaceRecord {
	schemaVersion: 1; item: Omit<CoordinatorItem, "coordinatorScope">; logicalScope: string; instanceId: string; namespace: string; recordHash: string;
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
type JournalBody = Omit<Journal, "journalHash">;
export type CoordinatorFault = "after-prepare" | "after-evidence" | "after-guard";
export type CoordinatorLockHooks = OwnedLockHooks;

function jsonClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function journalBody(journal: Journal): JournalBody { const { journalHash: _, ...body } = journal; return body; }
function withoutRecordHash(record: CoordinatorNamespaceRecord): Omit<CoordinatorNamespaceRecord, "recordHash"> { const { recordHash: _, ...body } = record; return body; }
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function acquireWaiting(lock: OwnedFileLock): OwnedLockRecord {
	for (let attempt = 0; attempt < 1000; attempt++) {
		try { return lock.acquire(); }
		catch (error: any) {
			if (!/locked by live owner/.test(String(error?.message))) throw error;
			sleep(5);
		}
	}
	throw new Error(`${lock.label} timed out waiting for serialized ownership`);
}

/** Coordinates durable evidence and admission with exact-input, process-safe replay. */
export class EvidenceAdmissionCoordinator {
	readonly guard: AdmissionGuard;
	readonly journalRoot: string;
	readonly lockRoot: string;
	readonly coordinatorNamespace: string;
	constructor(
		readonly root: string,
		readonly store: EvidenceStore,
		item: CoordinatorItem,
		policy: IncidentPolicy,
		serviceAllowlist: ReadonlySet<string>,
		humanAuthorizer: HumanAuthorizer = SYNTHETIC_HUMAN_AUTHORIZER,
		readonly testLockHooks?: CoordinatorLockHooks,
	) {
		this.journalRoot = path.join(root, "coordinator-journal");
		this.lockRoot = path.join(this.journalRoot, "locks");
		fs.mkdirSync(this.lockRoot, { recursive: true, mode: 0o700 });
		const initialization = new OwnedFileLock(path.join(root, "coordinator-init.lock"), "coordinator initialization");
		const initializationOwner = acquireWaiting(initialization);
		try {
			this.coordinatorNamespace = this.loadOrCreateNamespace(item);
			let guard: AdmissionGuard | undefined;
			for (let attempt = 0; attempt < 1000; attempt++) {
				try { guard = new AdmissionGuard(path.join(root, "guard"), item, policy, serviceAllowlist, humanAuthorizer, (hash) => store.hasContentHash(hash)); break; }
				catch (error: any) { if (!/admission guard is locked by live owner/.test(String(error?.message))) throw error; sleep(5); }
			}
			if (!guard) throw new Error("admission guard timed out waiting for coordinator initialization");
			this.guard = guard;
			this.discardUncommittedJournals();
			this.reconcile();
		} finally { initialization.release(initializationOwner); }
	}
	private namespaceFile(): string { return path.join(this.root, "coordinator-namespace.json"); }
	private loadOrCreateNamespace(item: CoordinatorItem): string {
		const file = this.namespaceFile();
		const stableItem = { id: item.id, version: item.version, itemHash: item.itemHash, catalogHash: item.catalogHash };
		if (fs.existsSync(file)) {
			const record = JSON.parse(fs.readFileSync(file, "utf8")) as CoordinatorNamespaceRecord;
			if (record.schemaVersion !== 1 || record.recordHash !== hashObject(withoutRecordHash(record)) || record.namespace !== hashObject({ item: record.item, logicalScope: record.logicalScope, instanceId: record.instanceId })) throw new Error("fail-closed: coordinator namespace authentication failed");
			if (hashObject(record.item) !== hashObject(stableItem) || (item.coordinatorScope !== undefined && record.logicalScope !== item.coordinatorScope)) throw new Error("fail-closed: coordinator namespace scope mismatch");
			return record.namespace;
		}
		if (item.coordinatorScope !== undefined) return hashObject({ item: stableItem, logicalScope: item.coordinatorScope, instanceId: `logical:${item.coordinatorScope}` });
		const logicalScope = "root-instance";
		const instanceId = randomUUID();
		const body = { schemaVersion: 1 as const, item: stableItem, logicalScope, instanceId, namespace: hashObject({ item: stableItem, logicalScope, instanceId }) };
		const record: CoordinatorNamespaceRecord = { ...body, recordHash: hashObject(body) };
		const temporary = `${file}.${randomUUID()}.tmp`;
		const descriptor = fs.openSync(temporary, "wx", 0o600);
		try { fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
		fs.renameSync(temporary, file); this.syncDirectory(this.root);
		return record.namespace;
	}
	authorize(boundary: "selection" | "dispatch") { return this.guard.authorize(boundary); }
	private journalFile(operationId: string): string { return path.join(this.journalRoot, `${hashObject(operationId)}.json`); }
	private lockFile(operationId: string): string { return path.join(this.lockRoot, `${hashObject(operationId)}.lock`); }
	private syncDirectory(directory: string): void { const descriptor = fs.openSync(directory, "r"); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
	private discardUncommittedJournals(): void {
		const groups = new Map<string, string[]>();
		for (const entry of fs.readdirSync(this.journalRoot)) {
			const match = /^([a-f0-9]{64})\.json\.[^.]+\.tmp$/.exec(entry);
			if (!match) continue;
			groups.set(match[1]!, [...(groups.get(match[1]!) ?? []), entry]);
		}
		for (const [operationHash, entries] of groups) {
			const lock = new OwnedFileLock(path.join(this.lockRoot, `${operationHash}.lock`), `coordinator operation ${operationHash}`);
			const owner = acquireWaiting(lock);
			try { for (const entry of entries) fs.rmSync(path.join(this.journalRoot, entry), { force: true }); this.syncDirectory(this.journalRoot); }
			finally { lock.release(owner); }
		}
	}
	private write(journal: Journal): void {
		journal.inputHash = hashObject(journal.input);
		journal.journalHash = hashObject(journalBody(journal));
		const file = this.journalFile(journal.operationId);
		const temporary = `${file}.${randomUUID()}.tmp`;
		const descriptor = fs.openSync(temporary, "wx", 0o600);
		try { fs.writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`); fs.fsyncSync(descriptor); }
		finally { fs.closeSync(descriptor); }
		fs.renameSync(temporary, file);
		this.syncDirectory(this.journalRoot);
	}
	private read(operationId: string): Journal {
		const file = this.journalFile(operationId);
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as any;
		const { journalHash: _, ...authenticatedBody } = parsed;
		if (![2, 3].includes(parsed.schemaVersion) || parsed.operationId !== operationId || !["incident", "publication"].includes(parsed.kind) || parsed.inputHash !== hashObject(parsed.input) || parsed.journalHash !== hashObject(authenticatedBody)) throw new Error("fail-closed: coordinator journal authentication failed");
		if ((parsed.kind === "incident" && operationId !== `incident:${parsed.input.report.idempotencyKey}`) || (parsed.kind === "publication" && operationId !== `publication:${parsed.input.id}`)) throw new Error("fail-closed: coordinator journal operation identity mismatch");
		if (parsed.schemaVersion === 2) {
			// Existing completed single-root journals remain readable without an
			// audit-time rewrite. Any later recovery write upgrades them to v3.
			parsed.schemaVersion = 3; parsed.coordinatorNamespace = this.coordinatorNamespace;
		} else if (parsed.coordinatorNamespace !== this.coordinatorNamespace) throw new Error("fail-closed: coordinator journal namespace mismatch");
		return parsed as Journal;
	}
	private compareInput(journal: Journal, input: Journal["input"]): void {
		if (hashObject(input) !== journal.inputHash) throw new Error("coordinator idempotency replay does not match the original exact operation input");
	}
	private acquireOperation(operationId: string): { lock: OwnedFileLock; owner: OwnedLockRecord } {
		const lock = new OwnedFileLock(this.lockFile(operationId), `coordinator operation ${operationId}`, this.testLockHooks);
		return { lock, owner: acquireWaiting(lock) };
	}
	private withOperation<T>(operationId: string, action: () => T): T {
		const { lock, owner } = this.acquireOperation(operationId);
		try { return action(); } finally { lock.release(owner); }
	}
	private maybeFault(fault: CoordinatorFault | undefined, point: CoordinatorFault): void { if (fault === point) throw new Error(`simulated coordinator crash ${point}`); }
	private retryGuard<T>(action: () => T): T {
		for (let attempt = 0; attempt < 1000; attempt++) {
			try { return action(); }
			catch (error: any) {
				if (!/admission guard is locked by live owner/.test(String(error?.message))) throw error;
				sleep(5);
			}
		}
		throw new Error("admission guard timed out waiting for serialized ownership");
	}
	private evidenceFor(journal: Journal, explicitSecrets: string[] = []): EvidenceIndexRecord {
		if (journal.evidence) return this.store.getByRef(journal.evidence.retrievalRef, { schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance }).record;
		const record = this.store.put({ value: journal.input.value, schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance, retentionUntil: journal.input.retentionUntil, explicitSecrets, indexId: `coordinator:${this.coordinatorNamespace}:${journal.operationId}` });
		journal.evidence = record; journal.state = "evidence-retained"; this.write(journal);
		return record;
	}
	private finishPublication(journal: PublicationJournal): CoordinatedPublication {
		const evidence = this.evidenceFor(journal);
		if (!journal.publication) {
			const published = this.retryGuard(() => this.guard.publish({ id: journal.input.id, kind: journal.input.publicationKind, expectedSequence: journal.input.expectedSequence, evidenceHash: evidence.contentHash }));
			journal.publication = { ...published, evidenceRef: evidence.retrievalRef };
			journal.state = "guard-committed"; this.write(journal);
		}
		if (journal.publication.evidenceHash !== evidence.contentHash || journal.publication.evidenceRef !== evidence.retrievalRef) throw new Error("fail-closed: coordinator publication/evidence binding mismatch");
		this.store.getByRef(journal.publication.evidenceRef, { schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance });
		return structuredClone(journal.publication);
	}
	private finishIncident(journal: IncidentJournal): { acknowledged: boolean; sequence: number; evidenceRef: string } {
		const evidence = this.evidenceFor(journal);
		if (!journal.ack) {
			const result = this.retryGuard(() => this.guard.applyIncident({ ...journal.input.report, evidenceHash: evidence.contentHash }));
			journal.ack = { acknowledged: result.acknowledged, sequence: result.sequence };
			journal.state = "guard-committed"; this.write(journal);
		}
		this.store.getByRef(evidence.retrievalRef, { schemaVersionRef: journal.input.schemaVersionRef, assetVersions: journal.input.assetVersions, participantProvenance: journal.input.participantProvenance });
		return { ...journal.ack, evidenceRef: evidence.retrievalRef };
	}
	publish(input: PublicationJournal["input"], faultAfter?: CoordinatorFault, explicitSecrets: string[] = []): CoordinatedPublication {
		const meaningful = [...new Set(explicitSecrets.filter((value) => value.length >= 8))];
		const original = JSON.stringify(input.value);
		if (meaningful.some((secret) => original.includes(secret))) throw new Error("credential material required redaction before evidence publication");
		const safeValue = redactValue(input.value, meaningful); assertRedacted(safeValue, meaningful);
		const safeInput = jsonClone<PublicationJournal["input"]>({ ...input, value: safeValue });
		const operationId = `publication:${safeInput.id}`;
		return this.withOperation(operationId, () => {
			const file = this.journalFile(operationId);
			let journal: PublicationJournal;
			if (fs.existsSync(file)) { journal = this.read(operationId) as PublicationJournal; if (journal.kind !== "publication") throw new Error("fail-closed: coordinator journal kind mismatch"); this.compareInput(journal, safeInput); }
			else { const body = { schemaVersion: 3 as const, coordinatorNamespace: this.coordinatorNamespace, operationId, kind: "publication" as const, state: "prepared" as const, input: safeInput, inputHash: hashObject(safeInput) }; journal = { ...body, journalHash: hashObject(body) }; this.write(journal); }
			this.maybeFault(faultAfter, "after-prepare");
			this.evidenceFor(journal, meaningful); this.maybeFault(faultAfter, "after-evidence");
			const publication = this.finishPublication(journal); this.maybeFault(faultAfter, "after-guard");
			return publication;
		});
	}
	incident(input: IncidentJournal["input"], faultAfter?: CoordinatorFault): { acknowledged: boolean; sequence: number; evidenceRef: string } {
		const safeInput = jsonClone(input);
		const operationId = `incident:${safeInput.report.idempotencyKey}`;
		return this.withOperation(operationId, () => {
			const file = this.journalFile(operationId);
			let journal: IncidentJournal;
			if (fs.existsSync(file)) { journal = this.read(operationId) as IncidentJournal; if (journal.kind !== "incident") throw new Error("fail-closed: coordinator journal kind mismatch"); this.compareInput(journal, safeInput); }
			else { const body = { schemaVersion: 3 as const, coordinatorNamespace: this.coordinatorNamespace, operationId, kind: "incident" as const, state: "prepared" as const, input: safeInput, inputHash: hashObject(safeInput) }; journal = { ...body, journalHash: hashObject(body) }; this.write(journal); }
			this.maybeFault(faultAfter, "after-prepare");
			this.evidenceFor(journal); this.maybeFault(faultAfter, "after-evidence");
			const result = this.finishIncident(journal); this.maybeFault(faultAfter, "after-guard");
			return result;
		});
	}
	reconcile(): void {
		for (const file of fs.readdirSync(this.journalRoot).filter((entry) => entry.endsWith(".json"))) {
			const parsed = JSON.parse(fs.readFileSync(path.join(this.journalRoot, file), "utf8")) as { operationId?: string };
			if (!parsed.operationId || file !== `${hashObject(parsed.operationId)}.json`) throw new Error("fail-closed: coordinator journal is invalid");
			this.withOperation(parsed.operationId, () => {
				const journal = this.read(parsed.operationId);
				if (journal.kind === "publication") this.finishPublication(journal); else this.finishIncident(journal);
			});
		}
	}
	snapshot() { this.reconcile(); return this.guard.snapshot(); }
}
