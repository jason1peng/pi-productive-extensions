import * as fs from "node:fs";
import * as path from "node:path";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	assistantMessages: number;
	sessionFiles: number;
}

export interface UsageRow extends UsageTotals {
	kind: "parent" | "subagent";
	path: string;
	runId?: string;
	runIndex?: string;
	agent?: string;
}

export interface CollectedSessionUsage {
	sessionFile?: string;
	baseDir?: string;
	rows: UsageRow[];
	total: UsageTotals;
}

export function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, assistantMessages: 0, sessionFiles: 0 };
}

export function addUsageTotals(target: UsageTotals, source: Partial<UsageTotals>) {
	target.input += source.input ?? 0;
	target.output += source.output ?? 0;
	target.cacheRead += source.cacheRead ?? 0;
	target.cacheWrite += source.cacheWrite ?? 0;
	target.totalTokens += source.totalTokens ?? 0;
	target.cost += source.cost ?? 0;
	target.assistantMessages += source.assistantMessages ?? 0;
	target.sessionFiles += source.sessionFiles ?? 0;
}

export function subtractUsageTotals(current: UsageTotals, baseline: UsageTotals): UsageTotals {
	return {
		input: Math.max(0, current.input - baseline.input),
		output: Math.max(0, current.output - baseline.output),
		cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
		cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
		totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
		cost: Math.max(0, current.cost - baseline.cost),
		assistantMessages: Math.max(0, current.assistantMessages - baseline.assistantMessages),
		sessionFiles: Math.max(0, current.sessionFiles - baseline.sessionFiles),
	};
}

function numeric(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
	return number !== undefined && Number.isFinite(number) ? number : undefined;
}

export function usageTotalsFromRawUsage(raw: any): UsageTotals {
	const input = numeric(raw?.input) ?? 0;
	const output = numeric(raw?.output) ?? 0;
	const cacheRead = numeric(raw?.cacheRead) ?? 0;
	const cacheWrite = numeric(raw?.cacheWrite) ?? 0;
	const totalTokens = numeric(raw?.totalTokens) ?? numeric(raw?.total) ?? input + output + cacheRead + cacheWrite;
	const cost = numeric(raw?.cost) ?? numeric(raw?.cost?.total) ?? 0;
	const assistantMessages = numeric(raw?.assistantMessages) ?? numeric(raw?.turns) ?? 1;
	return { input, output, cacheRead, cacheWrite, totalTokens, cost, assistantMessages, sessionFiles: 0 };
}

export function collectUsageFromJsonlContent(content: string, options: { countSessionFile?: boolean; asyncMessages?: boolean } = {}): UsageTotals {
	const totals = emptyUsageTotals();
	if (options.countSessionFile) totals.sessionFiles = 1;
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; recordType?: string; sourceEventType?: string; role?: string; usage?: any; message?: { role?: string; usage?: any } };
			const legacyUsage = entry.type === "message" && entry.message?.role === "assistant" ? entry.message.usage : undefined;
			const asyncUsage = options.asyncMessages && entry.recordType === "message" && entry.sourceEventType === "message_end" && entry.role === "assistant" ? entry.usage : undefined;
			const usage = legacyUsage ?? asyncUsage;
			if (usage) addUsageTotals(totals, usageTotalsFromRawUsage(usage));
		} catch {
			// Ignore malformed/non-JSON lines so one bad record does not break usage reporting.
		}
	}
	return totals;
}

export function collectUsageFromSessionFile(sessionFile: string): UsageTotals {
	try {
		return collectUsageFromJsonlContent(fs.readFileSync(sessionFile, "utf8"), { countSessionFile: true });
	} catch {
		return emptyUsageTotals();
	}
}

export function subagentSessionDirFor(sessionFile: string): string {
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : `${sessionFile}.d`;
}

export function discoverSessionJsonlFiles(root: string, options: { fileName?: string } = {}): string[] {
	const found: string[] = [];
	if (!fs.existsSync(root)) return found;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && (options.fileName ? entry.name === options.fileName : entry.name.endsWith(".jsonl"))) found.push(full);
		}
	}
	return found.sort();
}

export function deriveSubagentInfo(file: string, baseDir: string): Pick<UsageRow, "runId" | "runIndex" | "agent"> {
	const rel = path.relative(baseDir, file);
	const parts = rel.split(path.sep);
	const runId = parts[0];
	const runIndex = parts.find((part) => /^run-\d+$/.test(part));
	return { runId, runIndex };
}

export function collectSessionUsage(sessionFile: string | undefined, options: { childFileName?: string; includeEmptyRows?: boolean } = {}): CollectedSessionUsage {
	const rows: UsageRow[] = [];
	const total = emptyUsageTotals();
	if (!sessionFile) return { rows, total };

	const parentTotals = collectUsageFromSessionFile(sessionFile);
	if (options.includeEmptyRows || parentTotals.assistantMessages > 0) {
		rows.push({ kind: "parent", path: sessionFile, ...parentTotals });
	}
	addUsageTotals(total, parentTotals);

	const baseDir = subagentSessionDirFor(sessionFile);
	for (const childFile of discoverSessionJsonlFiles(baseDir, { fileName: options.childFileName })) {
		const childTotals = collectUsageFromSessionFile(childFile);
		if (!options.includeEmptyRows && childTotals.assistantMessages === 0) continue;
		const info = deriveSubagentInfo(childFile, baseDir);
		rows.push({ kind: "subagent", path: childFile, ...info, ...childTotals });
		addUsageTotals(total, childTotals);
	}

	return { sessionFile, baseDir, rows, total };
}
