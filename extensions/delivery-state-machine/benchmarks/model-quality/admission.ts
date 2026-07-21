import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { hashObject } from "./schema.ts";

export interface IncidentReport {
	idempotencyKey: string;
	itemId: string;
	itemVersion: number;
	itemHash: string;
	catalogHash: string;
	evidenceHash: string;
	reportClass: string;
	actorId: string;
}
export interface IncidentPolicyDecision { action: "hold" | "reject"; severity: number; reason: string; policyVersion: string }
export interface IncidentPolicy { version: string; decide(report: IncidentReport): IncidentPolicyDecision }
export interface HumanResolution {
	action: "quarantine" | "dismiss";
	actorId: string;
	actorRole: "authorized-human";
	signedIntent: string;
	itemHash: string;
	catalogHash: string;
	/** Exact immutable incident set covered by this intent. Unrelated holds remain pending. */
	incidentKeys: string[];
	expectedSequence: number;
	reason: string;
}
export interface HumanAuthorizer { version: string; verify(input: HumanResolution): boolean }
interface Publication { id: string; kind: "result-use" | "join" | "report"; sequence: number; eligibility: "eligible" | "TAINTED_OR_INVALIDATED"; evidenceHash: string }
interface Incident { report: IncidentReport; decision: IncidentPolicyDecision; sequence: number; status: "pending" | "quarantined" | "dismissed" }
interface AdmissionState {
	schemaVersion: 1;
	itemId: string;
	itemVersion: number;
	itemHash: string;
	catalogHash: string;
	sequence: number;
	admissionState: "admitted" | "quarantined";
	holdState: "clear" | "pending";
	incidents: Incident[];
	publications: Publication[];
	audit: Array<{ sequence: number; action: string; evidenceHash: string }>;
}

export interface AdmissionAuthorization { itemId: string; itemVersion: number; sequence: number; boundary: "selection" | "dispatch" }

function isHash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

export class AdmissionGuard {
	private readonly stateFile: string;
	private readonly journalFile: string;
	private readonly lockFile: string;
	constructor(readonly root: string, readonly item: { id: string; version: number; itemHash: string; catalogHash: string }, readonly policy: IncidentPolicy, readonly serviceAllowlist: ReadonlySet<string>, readonly humanAuthorizer: HumanAuthorizer = SYNTHETIC_HUMAN_AUTHORIZER) {
		if (![item.itemHash, item.catalogHash].every(isHash)) throw new Error("admission item hashes must be SHA-256");
		fs.mkdirSync(root, { recursive: true });
		this.stateFile = path.join(root, `${item.id}-${item.version}.json`);
		this.journalFile = `${this.stateFile}.journal`;
		this.lockFile = `${this.stateFile}.lock`;
		this.recover();
		if (!fs.existsSync(this.stateFile)) this.atomicWrite(this.initialState());
	}
	private initialState(): AdmissionState { return { schemaVersion: 1, itemId: this.item.id, itemVersion: this.item.version, itemHash: this.item.itemHash, catalogHash: this.item.catalogHash, sequence: 0, admissionState: "admitted", holdState: "clear", incidents: [], publications: [], audit: [] }; }
	private acquire(): number {
		for (let attempt = 0; attempt < 500; attempt++) {
			try {
				const fd = fs.openSync(this.lockFile, "wx", 0o600);
				fs.writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
				return fd;
			} catch (error: any) {
				if (error?.code !== "EEXIST") throw error;
				try {
					const owner = Number(fs.readFileSync(this.lockFile, "utf8").trim());
					if (!Number.isInteger(owner) || owner < 1) throw new Error("invalid stale lock owner");
					try { process.kill(owner, 0); } catch (signalError: any) { if (signalError?.code === "ESRCH") fs.rmSync(this.lockFile, { force: true }); else throw signalError; }
				} catch (lockError: any) {
					if (lockError?.code === "ENOENT") continue;
					if (String(lockError?.message).includes("invalid stale lock owner")) throw new Error("fail-closed: admission lock ownership is invalid");
				}
				sleep(2);
			}
		}
		throw new Error("admission guard lock timeout");
	}
	private release(fd: number): void { try { fs.closeSync(fd); } finally { fs.rmSync(this.lockFile, { force: true }); } }
	private read(): AdmissionState {
		const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as AdmissionState;
		if (state.schemaVersion !== 1 || state.itemId !== this.item.id || state.itemVersion !== this.item.version || state.itemHash !== this.item.itemHash || state.catalogHash !== this.item.catalogHash) throw new Error("admission state identity/hash mismatch");
		return state;
	}
	private atomicWrite(state: AdmissionState): void {
		const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, this.stateFile);
	}
	private transaction<T>(action: (state: AdmissionState) => T): T {
		const lock = this.acquire();
		try {
			const state = this.read();
			const result = action(state);
			fs.writeFileSync(this.journalFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			this.atomicWrite(state);
			fs.rmSync(this.journalFile, { force: true });
			return result;
		} finally { this.release(lock); }
	}
	private recover(): void {
		if (!fs.existsSync(this.journalFile)) return;
		const recovered = JSON.parse(fs.readFileSync(this.journalFile, "utf8")) as AdmissionState;
		if (recovered.itemId !== this.item.id || recovered.itemVersion !== this.item.version || recovered.itemHash !== this.item.itemHash || recovered.catalogHash !== this.item.catalogHash) throw new Error("fail-closed: journal identity/hash mismatch");
		this.atomicWrite(recovered);
		fs.rmSync(this.journalFile, { force: true });
	}
	private ensureEffective(state: AdmissionState): void {
		if (state.admissionState !== "admitted" || state.holdState !== "clear") throw new Error("item/version is not effectively admitted");
	}
	authorize(boundary: "selection" | "dispatch"): AdmissionAuthorization {
		return this.transaction((state) => { this.ensureEffective(state); return { itemId: state.itemId, itemVersion: state.itemVersion, sequence: state.sequence, boundary }; });
	}
	publish(input: { id: string; kind: Publication["kind"]; expectedSequence: number; evidenceHash: string }): Publication {
		if (!isHash(input.evidenceHash)) throw new Error("publication evidenceHash must be SHA-256");
		return this.transaction((state) => {
			const prior = state.publications.find((entry) => entry.id === input.id);
			if (prior) return structuredClone(prior);
			const eligible = state.admissionState === "admitted" && state.holdState === "clear" && state.sequence === input.expectedSequence;
			const publication: Publication = { ...input, sequence: state.sequence, eligibility: eligible ? "eligible" : "TAINTED_OR_INVALIDATED" };
			state.publications.push(publication);
			state.audit.push({ sequence: state.sequence, action: `publish:${input.kind}:${publication.eligibility}`, evidenceHash: input.evidenceHash });
			return structuredClone(publication);
		});
	}
	applyIncident(report: IncidentReport): { acknowledged: boolean; decision: IncidentPolicyDecision; sequence: number } {
		if (![report.itemHash, report.catalogHash, report.evidenceHash].every(isHash)) throw new Error("incident hashes must be SHA-256");
		if (!this.serviceAllowlist.has(report.actorId)) throw new Error("incident actor is not an allowlisted ingestion service");
		if (report.itemId !== this.item.id || report.itemVersion !== this.item.version || report.itemHash !== this.item.itemHash || report.catalogHash !== this.item.catalogHash) throw new Error("incident targets a stale or mismatched item/catalog hash");
		const decision = this.policy.decide(report);
		if (decision.policyVersion !== this.policy.version) throw new Error("incident policy version mismatch");
		return this.transaction((state) => {
			const duplicate = state.incidents.find((entry) => entry.report.idempotencyKey === report.idempotencyKey);
			if (duplicate) {
				if (hashObject(duplicate.report) !== hashObject(report)) throw new Error("idempotency key replay does not match the original exact report");
				return { acknowledged: duplicate.decision.action === "hold", decision: duplicate.decision, sequence: duplicate.sequence };
			}
			if (decision.action === "reject") {
				state.audit.push({ sequence: state.sequence, action: "incident:rejected", evidenceHash: report.evidenceHash });
				return { acknowledged: false, decision, sequence: state.sequence };
			}
			const pending = state.incidents.filter((entry) => entry.status === "pending");
			if (pending.some((entry) => entry.decision.severity > decision.severity)) throw new Error("incident severity downgrade is forbidden");
			state.sequence += 1;
			state.holdState = "pending";
			for (const publication of state.publications) publication.eligibility = "TAINTED_OR_INVALIDATED";
			state.incidents.push({ report, decision, sequence: state.sequence, status: "pending" });
			state.audit.push({ sequence: state.sequence, action: "incident:pending:all-publications-tainted", evidenceHash: report.evidenceHash });
			return { acknowledged: true, decision, sequence: state.sequence };
		});
	}
	resolve(input: HumanResolution): AdmissionState {
		if (input.actorRole !== "authorized-human" || input.actorId.trim() === "" || input.signedIntent.trim() === "" || !this.humanAuthorizer.verify(input)) throw new Error("resolution requires verified signed authorized-human intent");
		if (input.itemHash !== this.item.itemHash || input.catalogHash !== this.item.catalogHash) throw new Error("resolution hashes changed; create a successor version");
		if (!Array.isArray(input.incidentKeys) || input.incidentKeys.length === 0 || new Set(input.incidentKeys).size !== input.incidentKeys.length) throw new Error("resolution requires a unique non-empty exact incident set");
		return this.transaction((state) => {
			if (state.holdState !== "pending") throw new Error("no pending hold to resolve");
			if (state.sequence !== input.expectedSequence) throw new Error("resolution sequence is stale");
			const selected = input.incidentKeys.map((key) => state.incidents.find((entry) => entry.report.idempotencyKey === key));
			if (selected.some((entry) => !entry || entry.status !== "pending")) throw new Error("resolution incident set is stale, missing, or already resolved");
			state.sequence += 1;
			if (input.action === "quarantine") state.admissionState = "quarantined";
			for (const incident of selected as Incident[]) incident.status = input.action === "quarantine" ? "quarantined" : "dismissed";
			state.holdState = state.incidents.some((entry) => entry.status === "pending") ? "pending" : "clear";
			state.audit.push({ sequence: state.sequence, action: `human:${input.action}:${input.actorId}:${input.incidentKeys.sort().join(",")}`, evidenceHash: hashObject({ signedIntent: input.signedIntent, reason: input.reason, incidentKeys: input.incidentKeys, priorSequence: input.expectedSequence }) });
			return structuredClone(state);
		});
	}
	snapshot(): AdmissionState { const lock = this.acquire(); try { return structuredClone(this.read()); } finally { this.release(lock); } }
}

export const SYNTHETIC_HUMAN_AUTHORIZER: HumanAuthorizer = {
	version: "bootstrap-human-authorizer-v1",
	verify(input) {
		if (!["human-1", "human-2"].includes(input.actorId) || input.actorRole !== "authorized-human") return false;
		const { signedIntent: _, ...unsigned } = input;
		return input.signedIntent === `synthetic-signature:${hashObject(unsigned)}`;
	},
};
export function signSyntheticHumanResolution(input: Omit<HumanResolution, "signedIntent" | "actorRole">): HumanResolution {
	const unsigned = { ...input, actorRole: "authorized-human" as const };
	return { ...unsigned, signedIntent: `synthetic-signature:${hashObject(unsigned)}` };
}

export const SYNTHETIC_INCIDENT_POLICY: IncidentPolicy = {
	version: "bootstrap-incident-policy-v1",
	decide(report) {
		if (report.reportClass === "credible-bootstrap-leakage") return { action: "hold", severity: 2, reason: "synthetic credible leakage report", policyVersion: this.version };
		if (report.reportClass === "credible-bootstrap-leakage-critical") return { action: "hold", severity: 3, reason: "synthetic critical leakage report", policyVersion: this.version };
		return { action: "reject", severity: 0, reason: "report class is not trusted by the bootstrap policy", policyVersion: this.version };
	},
};
export const SYNTHETIC_SERVICE_ALLOWLIST = new Set(["bootstrap-incident-service"]);
