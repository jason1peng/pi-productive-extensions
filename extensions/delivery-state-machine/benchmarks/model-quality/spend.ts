import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EvidenceStore } from "./evidence.ts";
import { canonicalJson, hashObject } from "./schema.ts";

export interface SpendUsage { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; wallTimeMs: number; participant: string }
export interface SpendEntry { runId: string; rowId: string; state: "active" | "settled" | "failed"; reservedUsd: number; chargedUsd: number; startedAt: string; finishedAt?: string; attempts: SpendUsage[]; reason?: string }
export interface SpendState { schemaVersion: 2; ceilingUsd: number; importedSpendUsd: number; importedEvidence: unknown[]; ceilingHistory?: Array<{ fromUsd: number; toUsd: number; approvedBy: string; changedAt: string }>; sequence: number; entries: SpendEntry[]; stateHash: string }
export interface SpendSummary {
	ceilingUsd: number;
	warningThresholdsUsd: number[];
	triggeredWarningsUsd: number[];
	nextWarningUsd: number | null;
	importedUsd: number;
	acceptedUsd: number;
	rejectedUsd: number;
	activeReservedUsd: number;
	currentRunUsd: number;
	cumulativeUsd: number;
	attempts: Array<{ runId: string; rowId: string; state: SpendEntry["state"]; participant: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; wallTimeMs: number }>;
}
interface Pointer { schemaVersion: 1; stateHash: string; retrievalRef: string; pointerHash: string }
export interface SpendLockRecord { schemaVersion: 1; pid: number; processStart: string; nonce: string; createdAt: string; lockHash: string }
export type SpendCrashPoint = "after-lock" | "after-read" | "after-persist";

function lockContent(lock: SpendLockRecord): Omit<SpendLockRecord, "lockHash"> { const { lockHash: _, ...content } = lock; return content; }
export function spendProcessStart(pid = process.pid): string | null {
	try { const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return value || null; }
	catch { return null; }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; } }
function validateLock(value: unknown): SpendLockRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("spend ledger lock ownership is malformed");
	const lock = value as SpendLockRecord;
	if (lock.schemaVersion !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !lock.processStart || !lock.nonce || !Number.isFinite(Date.parse(lock.createdAt)) || lock.lockHash !== hashObject(lockContent(lock))) throw new Error("spend ledger lock ownership is malformed");
	return lock;
}

function stateContent(state: SpendState): Omit<SpendState, "stateHash"> { const { stateHash: _, ...content } = state; return content; }
function pointerContent(pointer: Pointer): Omit<Pointer, "pointerHash"> { const { pointerHash: _, ...content } = pointer; return content; }
function atomicJson(file: string, value: unknown): void { const temporary = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
function charged(state: SpendState): number { return state.importedSpendUsd + state.entries.reduce((sum, entry) => sum + (entry.state === "active" ? entry.reservedUsd : entry.chargedUsd), 0); }

/** Crash-safe, content-addressed cumulative paid-attempt ledger. */
export class SpendLedger {
	readonly pointerFile: string;
	readonly lockFile: string;
	constructor(readonly root: string, readonly store: EvidenceStore, readonly ceilingUsd: number, readonly provenance: string[], readonly testCrashPoint?: SpendCrashPoint) {
		this.pointerFile = path.join(root, "spend-ledger-v2.json"); this.lockFile = `${this.pointerFile}.lock`;
		fs.mkdirSync(root, { recursive: true });
		if (fs.existsSync(this.lockFile)) { const startupLock = this.acquireLock(); this.releaseLock(startupLock); }
		if (!fs.existsSync(this.pointerFile)) this.persist({ schemaVersion: 2, ceilingUsd, importedSpendUsd: 0, importedEvidence: [], ceilingHistory: [], sequence: 0, entries: [], stateHash: "" });
		else this.raiseCeilingIfApproved();
		this.reconcileIncomplete(); this.enforceConservativeFailures();
	}
	private validateForCeiling(state: SpendState, ceilingUsd: number): SpendState {
		if (state.schemaVersion !== 2 || state.ceilingUsd !== ceilingUsd || state.stateHash !== hashObject(stateContent(state))) throw new Error("spend ledger authentication/config mismatch");
		if (!Number.isFinite(state.importedSpendUsd) || state.importedSpendUsd < 0 || charged(state) > state.ceilingUsd + Number.EPSILON) throw new Error("spend ledger exceeds approved ceiling");
		return state;
	}
	private validate(state: SpendState): SpendState {
		this.validateForCeiling(state, this.ceilingUsd);
		if (!Number.isFinite(state.importedSpendUsd) || state.importedSpendUsd < 0 || charged(state) > state.ceilingUsd + Number.EPSILON) throw new Error("spend ledger exceeds approved ceiling");
		return state;
	}
	private raiseCeilingIfApproved(): void {
		const pointer = this.readPointer();
		const retained = this.store.getByRef(pointer.retrievalRef, { schemaVersionRef: "model-quality-spend-ledger-v2", participantProvenance: this.provenance });
		const state = JSON.parse(retained.content.toString("utf8")) as SpendState;
		this.validateForCeiling(state, state.ceilingUsd);
		if (state.stateHash !== pointer.stateHash) throw new Error("spend ledger pointer/state mismatch");
		if (state.ceilingUsd > this.ceilingUsd) throw new Error("approved cumulative ceiling may not be lowered");
		if (state.ceilingUsd === this.ceilingUsd) return;
		state.ceilingHistory = [...(state.ceilingHistory ?? []), { fromUsd: state.ceilingUsd, toUsd: this.ceilingUsd, approvedBy: "user-explicit-approval-2026-07-21", changedAt: new Date().toISOString() }];
		state.ceilingUsd = this.ceilingUsd;
		state.sequence += 1;
		this.persist(state);
	}
	private readPointer(): Pointer {
		const pointer = JSON.parse(fs.readFileSync(this.pointerFile, "utf8")) as Pointer;
		if (pointer.schemaVersion !== 1 || pointer.pointerHash !== hashObject(pointerContent(pointer))) throw new Error("spend ledger pointer authentication failed");
		return pointer;
	}
	read(): SpendState {
		const pointer = this.readPointer(); const retained = this.store.getByRef(pointer.retrievalRef, { schemaVersionRef: "model-quality-spend-ledger-v2", participantProvenance: this.provenance });
		const state = this.validate(JSON.parse(retained.content.toString("utf8")) as SpendState);
		if (state.stateHash !== pointer.stateHash) throw new Error("spend ledger pointer/state mismatch");
		return state;
	}
	private persist(input: SpendState): SpendState {
		const content = stateContent(input); const state: SpendState = { ...content, stateHash: hashObject(content) };
		const retained = this.store.put({ value: state, schemaVersionRef: "model-quality-spend-ledger-v2", assetVersions: [`ceiling:${this.ceilingUsd}`], participantProvenance: this.provenance, retentionUntil: "2099-01-01T00:00:00.000Z", indexId: `spend-ledger:${state.stateHash}` });
		const body = { schemaVersion: 1 as const, stateHash: state.stateHash, retrievalRef: retained.retrievalRef }; const pointer: Pointer = { ...body, pointerHash: hashObject(body) };
		atomicJson(this.pointerFile, pointer); return state;
	}
	private createLockRecord(): SpendLockRecord {
		const processStart = spendProcessStart();
		if (!processStart) throw new Error("spend ledger cannot establish process-start ownership");
		const body = { schemaVersion: 1 as const, pid: process.pid, processStart, nonce: randomUUID(), createdAt: new Date().toISOString() };
		return { ...body, lockHash: hashObject(body) };
	}
	private lockOwnerIsLive(lock: SpendLockRecord): boolean {
		if (!processAlive(lock.pid)) return false;
		const observed = spendProcessStart(lock.pid);
		if (!observed) throw new Error("spend ledger cannot validate live lock owner");
		return observed === lock.processStart;
	}
	private acquireLock(): SpendLockRecord {
		for (let attempt = 0; attempt < 3; attempt++) {
			const record = this.createLockRecord();
			const temporary = `${this.lockFile}.${record.nonce}.tmp`;
			fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
			try {
				fs.linkSync(temporary, this.lockFile);
				fs.rmSync(temporary, { force: true });
				return record;
			} catch (error: any) {
				fs.rmSync(temporary, { force: true });
				if (error?.code !== "EEXIST") throw error;
				let text: string; let stat: fs.Stats;
				try { text = fs.readFileSync(this.lockFile, "utf8"); stat = fs.statSync(this.lockFile); }
				catch { continue; }
				const owner = validateLock(JSON.parse(text));
				if (this.lockOwnerIsLive(owner)) throw new Error(`spend ledger is locked by live owner ${owner.pid}`);
				const currentText = fs.readFileSync(this.lockFile, "utf8"); const currentStat = fs.statSync(this.lockFile);
				if (currentText !== text || currentStat.ino !== stat.ino) continue;
				const stale = `${this.lockFile}.reclaimed-${record.nonce}`;
				fs.renameSync(this.lockFile, stale); fs.rmSync(stale, { force: true });
			}
		}
		throw new Error("spend ledger lock could not be acquired safely");
	}
	private releaseLock(lock: SpendLockRecord): void {
		if (!fs.existsSync(this.lockFile)) return;
		const retained = validateLock(JSON.parse(fs.readFileSync(this.lockFile, "utf8")));
		if (retained.nonce !== lock.nonce || retained.pid !== lock.pid || retained.processStart !== lock.processStart) throw new Error("spend ledger lock ownership changed before release");
		fs.rmSync(this.lockFile);
	}
	private maybeCrash(point: SpendCrashPoint): void { if (this.testCrashPoint === point) process.kill(process.pid, "SIGKILL"); }
	private transaction<T>(fn: (state: SpendState) => T): T {
		const lock = this.acquireLock();
		try {
			this.maybeCrash("after-lock");
			const state = this.read(); this.maybeCrash("after-read");
			const output = fn(state); state.sequence += 1; this.persist(state); this.maybeCrash("after-persist");
			return output;
		} finally { this.releaseLock(lock); }
	}
	migrateLegacy(importedSpendUsd: number, importedEvidence: unknown[]): SpendState {
		if (!Number.isFinite(importedSpendUsd) || importedSpendUsd < 0 || importedSpendUsd > this.ceilingUsd) throw new Error("legacy spend import is invalid");
		return this.transaction((state) => {
			if (state.importedSpendUsd > importedSpendUsd) throw new Error("spend migration may never lower prior spend");
			if (state.entries.length) throw new Error("legacy migration must precede v2 runs");
			state.importedSpendUsd = importedSpendUsd; state.importedEvidence = structuredClone(importedEvidence); return state;
		});
	}
	begin(runId: string, rowId: string, requestedReserveUsd: number): SpendEntry {
		return this.transaction((state) => {
			if (state.entries.some((entry) => entry.runId === runId)) throw new Error("duplicate spend run id");
			if (!Number.isFinite(requestedReserveUsd) || requestedReserveUsd <= 0) throw new Error("frozen row reservation must be finite and positive");
			const remaining = state.ceilingUsd - charged(state);
			if (requestedReserveUsd > remaining + Number.EPSILON) throw new Error("full frozen row reservation exceeds remaining approved cumulative ceiling before launch");
			const entry: SpendEntry = { runId, rowId, state: "active", reservedUsd: requestedReserveUsd, chargedUsd: 0, startedAt: new Date().toISOString(), attempts: [] };
			state.entries.push(entry); return structuredClone(entry);
		});
	}
	record(runId: string, usage: SpendUsage): SpendEntry {
		return this.transaction((state) => {
			const entry = state.entries.find((candidate) => candidate.runId === runId); if (!entry || entry.state !== "active") throw new Error("spend run is not active");
			for (const field of [usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.costUsd, usage.wallTimeMs]) if (!Number.isFinite(field) || field < 0) throw new Error("spend usage is invalid");
			entry.attempts.push(structuredClone(usage));
			const exact = entry.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
			if (state.importedSpendUsd + state.entries.filter((candidate) => candidate !== entry).reduce((sum, candidate) => sum + (candidate.state === "active" ? candidate.reservedUsd : candidate.chargedUsd), 0) + exact > state.ceilingUsd + Number.EPSILON) throw new Error("paid attempt exceeded approved cumulative ceiling");
			return structuredClone(entry);
		});
	}
	finish(runId: string, stateValue: "settled" | "failed", reason?: string): SpendEntry {
		return this.transaction((state) => {
			const entry = state.entries.find((candidate) => candidate.runId === runId); if (!entry || entry.state !== "active") throw new Error("spend run is not active");
			const exact = entry.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
			entry.state = stateValue; entry.chargedUsd = stateValue === "failed" ? Math.max(entry.reservedUsd, exact) : exact; entry.finishedAt = new Date().toISOString(); if (reason !== undefined) entry.reason = reason;
			if (charged(state) > state.ceilingUsd + Number.EPSILON) throw new Error("settled spend exceeds approved cumulative ceiling");
			return structuredClone(entry);
		});
	}
	enforceConservativeFailures(): SpendState {
		const state = this.read(); if (!state.entries.some((entry) => entry.state === "failed" && entry.chargedUsd < entry.reservedUsd)) return state;
		return this.transaction((current) => { for (const entry of current.entries.filter((candidate) => candidate.state === "failed")) entry.chargedUsd = Math.max(entry.chargedUsd, entry.reservedUsd); return current; });
	}
	reconcileIncomplete(): SpendState {
		const state = this.read(); if (!state.entries.some((entry) => entry.state === "active")) return state;
		return this.transaction((current) => { for (const entry of current.entries.filter((candidate) => candidate.state === "active")) { entry.state = "failed"; entry.chargedUsd = Math.max(entry.reservedUsd, entry.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0)); entry.finishedAt = new Date().toISOString(); entry.reason = "startup reconciliation conservatively closed an incomplete paid run"; } return current; });
	}
	total(): number { return charged(this.read()); }
	summary(currentRunIds: readonly string[] = [], warningThresholdsUsd: readonly number[] = [25, 50, 75]): SpendSummary {
		const state = this.read();
		const current = new Set(currentRunIds);
		const cumulativeUsd = charged(state);
		const acceptedUsd = state.entries.filter((entry) => entry.state === "settled").reduce((sum, entry) => sum + entry.chargedUsd, 0);
		const rejectedUsd = state.entries.filter((entry) => entry.state === "failed").reduce((sum, entry) => sum + entry.chargedUsd, 0);
		const activeReservedUsd = state.entries.filter((entry) => entry.state === "active").reduce((sum, entry) => sum + entry.reservedUsd, 0);
		const currentRunUsd = state.entries.filter((entry) => current.has(entry.runId)).reduce((sum, entry) => sum + (entry.state === "active" ? entry.reservedUsd : entry.chargedUsd), 0);
		const thresholds = [...warningThresholdsUsd];
		return {
			ceilingUsd: state.ceilingUsd,
			warningThresholdsUsd: thresholds,
			triggeredWarningsUsd: thresholds.filter((threshold) => cumulativeUsd >= threshold),
			nextWarningUsd: thresholds.find((threshold) => cumulativeUsd < threshold) ?? null,
			importedUsd: state.importedSpendUsd,
			acceptedUsd,
			rejectedUsd,
			activeReservedUsd,
			currentRunUsd,
			cumulativeUsd,
			attempts: state.entries.flatMap((entry) => entry.attempts.map((attempt) => ({ runId: entry.runId, rowId: entry.rowId, state: entry.state, ...attempt }))),
		};
	}
	audit(expectedMinimum: number): { totalUsd: number; stateHash: string; retrievalRef: string } {
		const state = this.read(); const total = charged(state); if (total + Number.EPSILON < expectedMinimum) throw new Error("spend ledger may not lower retained cumulative spend");
		const pointer = this.readPointer(); return { totalUsd: total, stateHash: state.stateHash, retrievalRef: pointer.retrievalRef };
	}
}
