import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./schema.ts";

export interface EvidenceIndexRecord {
	schemaVersion: 1;
	contentHash: string;
	mediaType: "application/json" | "text/plain";
	schemaVersionRef: string;
	assetVersions: string[];
	participantProvenance: string[];
	createdAt: string;
	retentionUntil: string;
	redactionState: "passed";
	retrievalRef: string;
}

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
	put(input: { value: unknown; schemaVersionRef: string; assetVersions: string[]; participantProvenance: string[]; retentionUntil: string; explicitSecrets?: string[]; mediaType?: EvidenceIndexRecord["mediaType"] }): EvidenceIndexRecord {
		if (!Number.isFinite(Date.parse(input.retentionUntil)) || Date.parse(input.retentionUntil) <= Date.now()) throw new Error("evidence retention must be a future ISO timestamp");
		const redacted = redactValue(input.value, input.explicitSecrets);
		assertRedacted(redacted, input.explicitSecrets);
		const content = input.mediaType === "text/plain" ? String(redacted) : `${JSON.stringify(redacted, null, 2)}\n`;
		const contentHash = sha256(content);
		const objectPath = path.join(this.objectRoot, contentHash);
		if (!fs.existsSync(objectPath)) fs.writeFileSync(objectPath, content, { flag: "wx", mode: 0o600 });
		else if (sha256(fs.readFileSync(objectPath)) !== contentHash) throw new Error("durable evidence object hash mismatch");
		const record: EvidenceIndexRecord = { schemaVersion: 1, contentHash, mediaType: input.mediaType ?? "application/json", schemaVersionRef: input.schemaVersionRef, assetVersions: input.assetVersions, participantProvenance: input.participantProvenance, createdAt: new Date().toISOString(), retentionUntil: input.retentionUntil, redactionState: "passed", retrievalRef: `sha256:${contentHash}` };
		fs.writeFileSync(path.join(this.indexRoot, `${randomUUID()}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		return record;
	}
	get(record: EvidenceIndexRecord): Buffer {
		if (record.redactionState !== "passed") throw new Error("unredacted evidence is unavailable");
		if (Date.parse(record.retentionUntil) <= Date.now()) throw new Error("evidence retention expired");
		if (record.retrievalRef !== `sha256:${record.contentHash}`) throw new Error("evidence retrieval reference mismatch");
		const file = path.join(this.objectRoot, record.contentHash);
		if (!fs.existsSync(file)) throw new Error("durable evidence is unavailable");
		const content = fs.readFileSync(file);
		if (sha256(content) !== record.contentHash) throw new Error("durable evidence hash mismatch");
		return content;
	}
	indexes(): EvidenceIndexRecord[] {
		return fs.readdirSync(this.indexRoot).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(this.indexRoot, file), "utf8")) as EvidenceIndexRecord);
	}
	getByRef(reference: string, expected?: { schemaVersionRef?: string; assetVersions?: string[]; participantProvenance?: string[] }): { record: EvidenceIndexRecord; content: Buffer } {
		const matches = this.indexes().filter((record) => record.retrievalRef === reference);
		if (matches.length !== 1) throw new Error(`durable evidence reference requires exactly one index: ${reference}`);
		const record = matches[0];
		if (expected?.schemaVersionRef && record.schemaVersionRef !== expected.schemaVersionRef) throw new Error("evidence schema provenance mismatch");
		for (const asset of expected?.assetVersions ?? []) if (!record.assetVersions.includes(asset)) throw new Error(`evidence asset provenance mismatch: ${asset}`);
		for (const participant of expected?.participantProvenance ?? []) if (!record.participantProvenance.includes(participant)) throw new Error(`evidence participant provenance mismatch: ${participant}`);
		return { record, content: this.get(record) };
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
