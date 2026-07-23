import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hashObject } from "./schema.ts";

export interface OwnedLockRecord { schemaVersion: 1; pid: number; processStart: string; nonce: string; createdAt: string; lockHash: string }
export interface OwnedLockHooks {
	beforeCandidateLinked?: (owner: OwnedLockRecord) => void;
	afterCandidateLinked?: (owner: OwnedLockRecord) => void;
	afterDeadOwnerValidated?: (owner: OwnedLockRecord) => void;
	afterLockAcquired?: (owner: OwnedLockRecord) => void;
}
interface Snapshot { record: OwnedLockRecord; stat: fs.Stats }

function content(lock: OwnedLockRecord): Omit<OwnedLockRecord, "lockHash"> { const { lockHash: _, ...body } = lock; return body; }
export function observedProcessStart(pid = process.pid): string | null {
	try { const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return value || null; }
	catch { return null; }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; } }
function validate(value: unknown, label: string): OwnedLockRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} lock ownership is malformed`);
	const lock = value as OwnedLockRecord;
	if (lock.schemaVersion !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !lock.processStart || !lock.nonce || !Number.isFinite(Date.parse(lock.createdAt)) || lock.lockHash !== hashObject(content(lock))) throw new Error(`${label} lock ownership is malformed`);
	return lock;
}
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

/** Cooperative exact-inode lock with authenticated process identity and stale recovery. */
export class OwnedFileLock {
	readonly reclaimFile: string;
	constructor(readonly lockFile: string, readonly label: string, readonly hooks?: OwnedLockHooks) { this.reclaimFile = `${lockFile}.reclaim`; }
	createRecord(): OwnedLockRecord {
		const processStart = observedProcessStart();
		if (!processStart) throw new Error(`${this.label} cannot establish process-start ownership`);
		const body = { schemaVersion: 1 as const, pid: process.pid, processStart, nonce: randomUUID(), createdAt: new Date().toISOString() };
		return { ...body, lockHash: hashObject(body) };
	}
	private snapshot(file: string): Snapshot {
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, "r");
			const stat = fs.fstatSync(fd);
			const record = validate(JSON.parse(fs.readFileSync(fd, "utf8")), this.label);
			return { record, stat };
		} finally { if (fd !== undefined) fs.closeSync(fd); }
	}
	private sameInode(file: string, stat: fs.Stats): boolean {
		try { const current = fs.statSync(file); return current.dev === stat.dev && current.ino === stat.ino; }
		catch { return false; }
	}
	private ownerIsLive(lock: OwnedLockRecord): boolean {
		if (!processAlive(lock.pid)) return false;
		const observed = observedProcessStart(lock.pid);
		if (!observed) throw new Error(`${this.label} cannot validate live lock owner`);
		return observed === lock.processStart;
	}
	private removeMarkerIfSame(marker: Snapshot): void {
		if (!this.sameInode(this.reclaimFile, marker.stat)) return;
		try { fs.rmSync(this.reclaimFile); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	}
	/**
	 * Complete a fenced recovery. If a contender died after linking a different
	 * primary inode but before observing the marker, retire the old marker and
	 * fence that exact dead candidate in the next loop. A live/PID-matching
	 * candidate is never removed.
	 */
	private helpReclamation(): void {
		for (let attempt = 0; attempt < 40; attempt++) {
			let marker: Snapshot;
			try { marker = this.snapshot(this.reclaimFile); }
			catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
			if (this.ownerIsLive(marker.record)) {
				this.removeMarkerIfSame(marker);
				throw new Error(`${this.label} is locked by live owner ${marker.record.pid}`);
			}
			let primary: Snapshot | undefined;
			try { primary = this.snapshot(this.lockFile); }
			catch (error: any) { if (error?.code !== "ENOENT") throw error; }
			if (!primary) { this.removeMarkerIfSame(marker); continue; }
			const same = primary.stat.dev === marker.stat.dev && primary.stat.ino === marker.stat.ino;
			if (same) {
				// Marker presence fences every cooperative candidate. Verify it still
				// names this inode immediately before unlinking the primary pathname.
				if (!this.sameInode(this.reclaimFile, marker.stat)) continue;
				try { fs.rmSync(this.lockFile); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
				continue;
			}
			if (this.ownerIsLive(primary.record)) {
				// The different candidate has not returned ownership while the marker
				// exists. Leave both paths intact until it withdraws; never unlink it.
				sleep(2);
				continue;
			}
			// The different candidate died (or its PID was reused) before returning.
			// Retire only the exact old marker. The dead primary remains in place,
			// so no third candidate can enter before it is fenced on the next pass.
			this.removeMarkerIfSame(marker);
			try { fs.linkSync(this.lockFile, this.reclaimFile); }
			catch (error: any) {
				if (error?.code === "ENOENT" || error?.code === "EEXIST") continue;
				throw error;
			}
		}
		throw new Error(`${this.label} reclamation is waiting for a live contending owner to withdraw`);
	}
	private withdraw(record: OwnedLockRecord): void {
		try {
			const retained = this.snapshot(this.lockFile);
			if (retained.record.nonce === record.nonce && retained.record.pid === record.pid && retained.record.processStart === record.processStart && this.sameInode(this.lockFile, retained.stat)) fs.rmSync(this.lockFile);
		} catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	}
	acquire(): OwnedLockRecord {
		for (let attempt = 0; attempt < 40; attempt++) {
			this.helpReclamation();
			const record = this.createRecord();
			const temporary = `${this.lockFile}.${record.nonce}.tmp`;
			fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
			try {
				this.hooks?.beforeCandidateLinked?.(record);
				fs.linkSync(temporary, this.lockFile);
				fs.rmSync(temporary, { force: true });
				this.hooks?.afterCandidateLinked?.(record);
				if (fs.existsSync(this.reclaimFile)) { this.withdraw(record); continue; }
				this.hooks?.afterLockAcquired?.(record);
				if (fs.existsSync(this.reclaimFile)) this.helpReclamation();
				return record;
			} catch (error: any) {
				fs.rmSync(temporary, { force: true });
				if (error?.code !== "EEXIST") throw error;
				let owner: Snapshot;
				try { owner = this.snapshot(this.lockFile); } catch (readError: any) { if (readError?.code === "ENOENT") continue; throw readError; }
				if (this.ownerIsLive(owner.record)) throw new Error(`${this.label} is locked by live owner ${owner.record.pid}`);
				this.hooks?.afterDeadOwnerValidated?.(owner.record);
				try { fs.linkSync(this.lockFile, this.reclaimFile); }
				catch (linkError: any) {
					if (linkError?.code === "ENOENT") continue;
					if (linkError?.code !== "EEXIST") throw linkError;
				}
				this.helpReclamation();
			}
		}
		throw new Error(`${this.label} lock could not be acquired safely`);
	}
	release(lock: OwnedLockRecord): void {
		let retained: Snapshot;
		try { retained = this.snapshot(this.lockFile); } catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
		if (retained.record.nonce !== lock.nonce || retained.record.pid !== lock.pid || retained.record.processStart !== lock.processStart) throw new Error(`${this.label} lock ownership changed before release`);
		if (!this.sameInode(this.lockFile, retained.stat)) throw new Error(`${this.label} lock inode changed before release`);
		fs.rmSync(this.lockFile);
	}
}
