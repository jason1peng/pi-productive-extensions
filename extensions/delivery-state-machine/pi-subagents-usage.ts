import * as fs from "node:fs";
import * as path from "node:path";
import { addUsageTotals, collectUsageFromJsonlContent, emptyUsageTotals, usageTotalsFromRawUsage, type UsageTotals } from "../../shared/session-usage.ts";

export type ChildUsageStatus = "resolved" | "unavailable" | "mismatch";

export interface ChildUsageEvidence {
	status: ChildUsageStatus;
	usage?: UsageTotals;
	identity?: string;
	runId?: string;
	transcriptPath?: string;
	reason?: string;
	metadataVersion: "modelAttempts" | "legacy-usage" | "unknown";
}

export interface PlannedChildIdentity {
	artifact?: string;
	agent?: string;
	startedAt?: number;
	endedAt?: number;
}

interface ModelAttempt { usage?: unknown }
export interface PiSubagentMetadata {
	runId?: string;
	agent?: string;
	task?: string;
	timestamp?: number;
	transcriptPath?: string;
	modelAttempts?: ModelAttempt[];
	usage?: unknown;
	_metaFile?: string;
}

function usable(usage: UsageTotals): boolean {
	return usage.assistantMessages > 0 || usage.totalTokens > 0 || usage.cost > 0;
}

export function usageFromPiSubagentMetadata(meta: PiSubagentMetadata): { usage?: UsageTotals; version: ChildUsageEvidence["metadataVersion"] } {
	if (Array.isArray(meta.modelAttempts)) {
		const total = emptyUsageTotals();
		for (const attempt of meta.modelAttempts) {
			if (attempt?.usage && typeof attempt.usage === "object") addUsageTotals(total, usageTotalsFromRawUsage(attempt.usage));
		}
		return { usage: usable(total) ? total : undefined, version: "modelAttempts" };
	}
	if (meta.usage && typeof meta.usage === "object") {
		const usage = usageTotalsFromRawUsage(meta.usage);
		return { usage: usable(usage) ? usage : undefined, version: "legacy-usage" };
	}
	return { version: "unknown" };
}

interface TranscriptUsageEvidence {
	usage?: UsageTotals;
	complete: boolean;
}

function transcriptUsageEvidence(file: string | undefined): TranscriptUsageEvidence {
	if (!file) return { complete: false };
	try {
		const content = fs.readFileSync(file, "utf8");
		const records = content.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
		const last = records.at(-1);
		const message = last?.message && typeof last.message === "object" ? last.message as Record<string, unknown> : undefined;
		const stopReason = last?.stopReason ?? message?.stopReason;
		const complete = last?.recordType === "message"
			&& last.sourceEventType === "message_end"
			&& last.role === "assistant"
			&& typeof stopReason === "string"
			&& stopReason !== "toolUse";
		const usage = collectUsageFromJsonlContent(content, { asyncMessages: true, countSessionFile: true });
		return { usage: usable(usage) ? usage : undefined, complete };
	} catch {
		return { complete: false };
	}
}

export function usageFromPiSubagentTranscript(file: string | undefined): UsageTotals | undefined {
	return transcriptUsageEvidence(file).usage;
}

function sameUsage(a: UsageTotals, b: UsageTotals): boolean {
	return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
		&& a.totalTokens === b.totalTokens && Math.abs(a.cost - b.cost) < 1e-9;
}

function taskContainsExactArtifact(task: string, artifact: string): boolean {
	let offset = 0;
	while (offset <= task.length - artifact.length) {
		const index = task.indexOf(artifact, offset);
		if (index < 0) return false;
		const before = task[index - 1];
		const afterIndex = index + artifact.length;
		const after = task[afterIndex];
		const afterNext = task[afterIndex + 1];
		const validBefore = before === undefined || /[\s`"'([{<:=]/.test(before);
		const validAfter = after === undefined
			|| /[\s`"')\]}> ,;:!?]/.test(after)
			|| (after === "." && (afterNext === undefined || /\s/.test(afterNext)));
		if (validBefore && validAfter) return true;
		offset = index + 1;
	}
	return false;
}

function matches(meta: PiSubagentMetadata, child: PlannedChildIdentity): boolean {
	if (!child.artifact || typeof meta.task !== "string" || !taskContainsExactArtifact(meta.task, child.artifact)) return false;
	if (child.agent && meta.agent && child.agent !== meta.agent) return false;
	if (meta.timestamp !== undefined && child.startedAt && meta.timestamp < child.startedAt - 5000) return false;
	if (meta.timestamp !== undefined && child.endedAt && meta.timestamp > child.endedAt + 5000) return false;
	return true;
}

function stableIdentity(meta: PiSubagentMetadata): string | undefined {
	if (meta.transcriptPath) return path.resolve(meta.transcriptPath);
	if (meta._metaFile) return path.resolve(meta._metaFile);
	return undefined;
}

export function resolvePiSubagentChildUsage(child: PlannedChildIdentity, metadata: PiSubagentMetadata[]): ChildUsageEvidence {
	const candidates = metadata.filter((meta) => matches(meta, child));
	const identities = new Map<string, PiSubagentMetadata[]>();
	for (const meta of candidates) {
		const identity = stableIdentity(meta);
		if (identity) identities.set(identity, [...(identities.get(identity) ?? []), meta]);
	}
	if (identities.size === 0) return { status: "unavailable", reason: "no uniquely identifiable metadata matched the exact planned artifact", metadataVersion: "unknown" };
	if (identities.size !== 1) return { status: "unavailable", reason: `ambiguous metadata: ${identities.size} children matched`, metadataVersion: "unknown" };
	const [identity, sameChildMetadata] = [...identities.entries()][0]!;
	const normalizedRows = sameChildMetadata.map((meta) => usageFromPiSubagentMetadata(meta));
	const normalizedUsages = normalizedRows.flatMap((row) => row.usage ? [row.usage] : []);
	const contradictory = normalizedUsages.some((usage, index) => index > 0 && !sameUsage(usage, normalizedUsages[0]!));
	const meta = sameChildMetadata[0]!;
	const normalized = normalizedRows[0]!;
	if (contradictory) return { status: "mismatch", identity, runId: meta.runId, transcriptPath: meta.transcriptPath, reason: "metadata records for one child identity contradict each other", metadataVersion: normalized.version };
	const transcript = transcriptUsageEvidence(meta.transcriptPath);
	if (!normalized.usage) {
		if (transcript.complete && transcript.usage) {
			return { status: "resolved", usage: transcript.usage, identity, runId: meta.runId, transcriptPath: meta.transcriptPath, metadataVersion: normalized.version };
		}
		return { status: "unavailable", identity, runId: meta.runId, transcriptPath: meta.transcriptPath, reason: transcript.usage
			? "metadata has no usage and the child transcript is incomplete"
			: "metadata has no usage-bearing model attempts or complete usage-bearing transcript", metadataVersion: normalized.version };
	}
	if (transcript.usage && !sameUsage(normalized.usage, transcript.usage)) {
		return { status: "mismatch", identity, runId: meta.runId, transcriptPath: meta.transcriptPath, reason: "metadata total contradicts transcript assistant usage", metadataVersion: normalized.version };
	}
	return { status: "resolved", usage: normalized.usage, identity, runId: meta.runId, transcriptPath: meta.transcriptPath, metadataVersion: normalized.version };
}

export function readPiSubagentMetadataFiles(directories: string[]): PiSubagentMetadata[] {
	const result: PiSubagentMetadata[] = [];
	const seen = new Set<string>();
	for (const directory of directories) {
		let names: string[];
		try { names = fs.readdirSync(directory); } catch { continue; }
		for (const name of names) {
			if (!name.endsWith("_meta.json")) continue;
			const file = path.join(directory, name);
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PiSubagentMetadata;
				const meta = raw.transcriptPath && !path.isAbsolute(raw.transcriptPath) ? { ...raw, transcriptPath: path.resolve(directory, raw.transcriptPath) } : raw;
				const metaFileIdentity = fs.realpathSync(file);
				if (!seen.has(metaFileIdentity)) { seen.add(metaFileIdentity); result.push({ ...meta, _metaFile: file }); }
			} catch { /* corrupt metadata is unavailable, never guessed */ }
		}
	}
	return result;
}
