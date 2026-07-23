import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./schema.ts";

export interface EvidenceIndexRecord {
	schemaVersion: 2;
	contentHash: string;
	mediaType: "application/json" | "text/plain";
	schemaVersionRef: string;
	assetVersions: string[];
	participantProvenance: string[];
	createdAt: string;
	retentionUntil: string;
	redactionState: "passed";
	retrievalRef: string;
	indexHash: string;
}

type IndexContent = Omit<EvidenceIndexRecord, "indexHash">;

const LEGACY_REFERENCE = /^sha256:([a-f0-9]{64})$/;
const EXACT_REFERENCE = /^sha256:([a-f0-9]{64})#index:([a-f0-9-]{36,64})$/;

const SECRET_PATTERNS = [
	/(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s"']{8,}/ig,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
	/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
];

export function redactValue(value: unknown, explicitSecrets: string[] = []): unknown {
	const secrets = [...new Set(explicitSecrets.filter((secret) => secret.length >= 8))].sort((a, b) => b.length - a.length);
	function visit(entry: unknown): unknown {
		if (typeof entry === "string") {
			let text = secrets.reduce((current, secret) => current.split(secret).join("[REDACTED]"), entry);
			for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
			return text;
		}
		if (Array.isArray(entry)) return entry.map(visit);
		if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, nested]) => [key, /chain.?of.?thought|raw.?transcript/i.test(key) ? "[OMITTED]" : visit(nested)]));
		return entry;
	}
	return visit(value);
}

export function assertRedacted(value: unknown, explicitSecrets: string[] = []): void {
	const text = canonicalJson(value);
	for (const secret of explicitSecrets.filter((entry) => entry.length >= 8)) if (text.includes(secret)) throw new Error("redaction failed: explicit credential remains");
	for (const pattern of SECRET_PATTERNS) { pattern.lastIndex = 0; if (pattern.test(text)) throw new Error("redaction failed: credential-like material remains"); }
}

function contentOf(record: EvidenceIndexRecord | IndexContent): IndexContent {
	const { indexHash: _, ...content } = record as EvidenceIndexRecord;
	return content;
}

function validateIndex(value: unknown, expectedIndexIdentity?: string): EvidenceIndexRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence index must be an object");
	const record = value as EvidenceIndexRecord;
	const expected = ["schemaVersion", "contentHash", "mediaType", "schemaVersionRef", "assetVersions", "participantProvenance", "createdAt", "retentionUntil", "redactionState", "retrievalRef", "indexHash"].sort();
	if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected)) throw new Error("evidence index fields are invalid");
	if (record.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(record.contentHash) || !/^[a-f0-9]{64}$/.test(record.indexHash)) throw new Error("evidence index hashes/schema are invalid");
	if (!Array.isArray(record.assetVersions) || !Array.isArray(record.participantProvenance) || record.assetVersions.some((entry) => typeof entry !== "string" || !entry) || record.participantProvenance.some((entry) => typeof entry !== "string" || !entry)) throw new Error("evidence index provenance is invalid");
	const legacy = LEGACY_REFERENCE.exec(record.retrievalRef);
	const exact = EXACT_REFERENCE.exec(record.retrievalRef);
	if ((!legacy && !exact) || (legacy?.[1] ?? exact?.[1]) !== record.contentHash || (expectedIndexIdentity && exact && exact[2] !== expectedIndexIdentity) || record.redactionState !== "passed" || !["application/json", "text/plain"].includes(record.mediaType)) throw new Error("evidence index retrieval/redaction/media contract is invalid");
	if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.retentionUntil))) throw new Error("evidence index timestamps are invalid");
	if (sha256(canonicalJson(contentOf(record))) !== record.indexHash) throw new Error("evidence index authentication failed");
	return record;
}

export class EvidenceStore {
	readonly objectRoot: string;
	readonly indexRoot: string;
	constructor(readonly root: string) {
		if (!path.isAbsolute(root)) throw new Error("durable evidence root must be absolute");
		this.objectRoot = path.join(root, "objects", "sha256");
		this.indexRoot = path.join(root, "indexes");
		fs.mkdirSync(this.objectRoot, { recursive: true });
		fs.mkdirSync(this.indexRoot, { recursive: true });
	}
	put(input: { value: unknown; schemaVersionRef: string; assetVersions: string[]; participantProvenance: string[]; retentionUntil: string; explicitSecrets?: string[]; mediaType?: EvidenceIndexRecord["mediaType"]; indexId?: string }): EvidenceIndexRecord {
		if (!Number.isFinite(Date.parse(input.retentionUntil)) || Date.parse(input.retentionUntil) <= Date.now()) throw new Error("evidence retention must be a future ISO timestamp");
		const redacted = redactValue(input.value, input.explicitSecrets);
		assertRedacted(redacted, input.explicitSecrets);
		const content = input.mediaType === "text/plain" ? String(redacted) : `${JSON.stringify(redacted, null, 2)}\n`;
		const contentHash = sha256(content);
		const objectPath = path.join(this.objectRoot, contentHash);
		try { fs.writeFileSync(objectPath, content, { flag: "wx", mode: 0o600 }); }
		catch (error: any) { if (error?.code !== "EEXIST") throw error; }
		let objectValid = false;
		for (let attempt = 0; attempt < 1000; attempt++) {
			try { if (sha256(fs.readFileSync(objectPath)) === contentHash) { objectValid = true; break; } } catch {}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
		if (!objectValid) throw new Error("durable evidence object hash mismatch");
		const indexIdentity = input.indexId ? sha256(input.indexId) : randomUUID();
		const indexName = `${indexIdentity}.json`;
		const indexPath = path.join(this.indexRoot, indexName);
		if (fs.existsSync(indexPath)) {
			const existing = validateIndex(JSON.parse(fs.readFileSync(indexPath, "utf8")), indexIdentity);
			if (existing.contentHash !== contentHash || existing.schemaVersionRef !== input.schemaVersionRef || canonicalJson(existing.assetVersions) !== canonicalJson(input.assetVersions) || canonicalJson(existing.participantProvenance) !== canonicalJson(input.participantProvenance)) throw new Error("evidence idempotency key conflicts with retained record");
			return existing;
		}
		const body: IndexContent = { schemaVersion: 2, contentHash, mediaType: input.mediaType ?? "application/json", schemaVersionRef: input.schemaVersionRef, assetVersions: [...input.assetVersions], participantProvenance: [...input.participantProvenance], createdAt: new Date().toISOString(), retentionUntil: input.retentionUntil, redactionState: "passed", retrievalRef: input.indexId ? `sha256:${contentHash}#index:${indexIdentity}` : `sha256:${contentHash}` };
		const record: EvidenceIndexRecord = { ...body, indexHash: sha256(canonicalJson(body)) };
		const temporary = `${indexPath}.${randomUUID()}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, indexPath);
		return record;
	}
	/** Explicit one-time migration. Audits never silently bless unauthenticated indexes. */
	sealLegacyIndexes(): number {
		let sealed = 0;
		for (const file of fs.readdirSync(this.indexRoot).filter((entry) => entry.endsWith(".json"))) {
			const target = path.join(this.indexRoot, file); const value = JSON.parse(fs.readFileSync(target, "utf8")) as any;
			if (value.schemaVersion === 2 && value.indexHash) { validateIndex(value, file.slice(0, -5)); continue; }
			if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.contentHash) || value.retrievalRef !== `sha256:${value.contentHash}`) throw new Error(`legacy evidence index cannot be authenticated: ${file}`);
			const body: IndexContent = { ...value, schemaVersion: 2 };
			const record = { ...body, indexHash: sha256(canonicalJson(body)) };
			fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); sealed += 1;
		}
		return sealed;
	}
	get(record: EvidenceIndexRecord): Buffer {
		validateIndex(record);
		if (Date.parse(record.retentionUntil) <= Date.now()) throw new Error("evidence retention expired");
		const file = path.join(this.objectRoot, record.contentHash);
		if (!fs.existsSync(file)) throw new Error("durable evidence is unavailable");
		const content = fs.readFileSync(file);
		if (sha256(content) !== record.contentHash) throw new Error("durable evidence hash mismatch");
		return content;
	}
	indexes(): EvidenceIndexRecord[] {
		return fs.readdirSync(this.indexRoot).filter((file) => file.endsWith(".json")).map((file) => validateIndex(JSON.parse(fs.readFileSync(path.join(this.indexRoot, file), "utf8")), file.slice(0, -5)));
	}
	getByRef(reference: string, expected?: { schemaVersionRef?: string; assetVersions?: string[]; participantProvenance?: string[] }): { record: EvidenceIndexRecord; content: Buffer } {
		const exact = EXACT_REFERENCE.exec(reference);
		const legacy = LEGACY_REFERENCE.exec(reference);
		if (!exact && !legacy) throw new Error(`durable evidence reference is invalid: ${reference}`);
		let record: EvidenceIndexRecord;
		if (exact) {
			const [, contentHash, indexIdentity] = exact;
			const file = path.join(this.indexRoot, `${indexIdentity}.json`);
			if (!fs.existsSync(file)) throw new Error(`durable evidence exact index is unavailable: ${reference}`);
			record = validateIndex(JSON.parse(fs.readFileSync(file, "utf8")), indexIdentity);
			if (record.retrievalRef !== reference || record.contentHash !== contentHash) throw new Error("durable evidence exact index binding mismatch");
		} else {
			const matches = this.indexes().filter((candidate) => candidate.contentHash === legacy![1]);
			if (matches.length !== 1) throw new Error(`durable legacy evidence reference requires exactly one index: ${reference}`);
			record = matches[0]!;
		}

		if (expected?.schemaVersionRef && record.schemaVersionRef !== expected.schemaVersionRef) throw new Error("evidence schema provenance mismatch");
		for (const asset of expected?.assetVersions ?? []) if (!record.assetVersions.includes(asset)) throw new Error(`evidence asset provenance mismatch: ${asset}`);
		for (const participant of expected?.participantProvenance ?? []) if (!record.participantProvenance.includes(participant)) throw new Error(`evidence participant provenance mismatch: ${participant}`);
		return { record, content: this.get(record) };
	}
	hasContentHash(hash: string): boolean {
		if (!/^[a-f0-9]{64}$/.test(hash)) return false;
		return this.indexes().some((record) => record.contentHash === hash && (() => { try { this.get(record); return true; } catch { return false; } })());
	}
	audit(): { objects: number; indexes: number } {
		const records = this.indexes();
		for (const record of records) this.get(record);
		const referenced = new Set(records.map((record) => record.contentHash));
		const objects = fs.readdirSync(this.objectRoot);
		for (const object of objects) if (!referenced.has(object)) throw new Error(`orphan durable evidence object: ${object}`);
		return { objects: objects.length, indexes: records.length };
	}
}
