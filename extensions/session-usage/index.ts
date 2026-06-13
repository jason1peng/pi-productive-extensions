import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	assistantMessages: number;
}

interface UsageRow extends UsageTotals {
	kind: "parent" | "subagent";
	path: string;
	runId?: string;
	runIndex?: string;
	agent?: string;
}

const emptyTotals = (): UsageTotals => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	assistantMessages: 0,
});

function addTotals(target: UsageTotals, source: UsageTotals) {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost += source.cost;
	target.assistantMessages += source.assistantMessages;
}

function parseUsageFile(file: string): UsageTotals {
	const totals = emptyTotals();
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch {
		return totals;
	}

	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "assistant" || !message.usage) continue;
		const usage = message.usage;
		totals.assistantMessages += 1;
		totals.input += Number(usage.input ?? 0);
		totals.output += Number(usage.output ?? 0);
		totals.cacheRead += Number(usage.cacheRead ?? 0);
		totals.cacheWrite += Number(usage.cacheWrite ?? 0);
		totals.totalTokens += Number(usage.totalTokens ?? usage.total ?? 0);
		totals.cost += Number(usage.cost?.total ?? 0);
	}

	return totals;
}

function walkSessionJsonl(root: string): string[] {
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
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name === "session.jsonl") {
				found.push(full);
			}
		}
	}
	return found.sort();
}

function deriveSubagentInfo(file: string, baseDir: string): Pick<UsageRow, "runId" | "runIndex" | "agent"> {
	const rel = path.relative(baseDir, file);
	const parts = rel.split(path.sep);
	const runId = parts[0];
	const runIndex = parts.find((part) => /^run-\d+$/.test(part));
	return { runId, runIndex };
}

function collectSessionUsage(sessionFile: string | undefined): { sessionFile?: string; baseDir?: string; rows: UsageRow[]; total: UsageTotals } {
	const rows: UsageRow[] = [];
	const total = emptyTotals();
	if (!sessionFile) return { rows, total };

	const parentTotals = parseUsageFile(sessionFile);
	if (parentTotals.assistantMessages > 0) {
		rows.push({ kind: "parent", path: sessionFile, ...parentTotals });
		addTotals(total, parentTotals);
	}

	const baseDir = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : `${sessionFile}.d`;
	for (const childFile of walkSessionJsonl(baseDir)) {
		const childTotals = parseUsageFile(childFile);
		if (childTotals.assistantMessages === 0) continue;
		const info = deriveSubagentInfo(childFile, baseDir);
		rows.push({ kind: "subagent", path: childFile, ...info, ...childTotals });
		addTotals(total, childTotals);
	}

	return { sessionFile, baseDir, rows, total };
}

function fmtInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function fmtCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function formatUsageReport(result: ReturnType<typeof collectSessionUsage>): string {
	const lines: string[] = [];
	lines.push("# Session usage including subagents");
	lines.push("");
	lines.push(`Session: ${result.sessionFile ?? "<none>"}`);
	if (result.baseDir) lines.push(`Subagent dir: ${result.baseDir}`);
	lines.push("");
	lines.push("## Total");
	lines.push(`- Tokens: ${fmtInt(result.total.totalTokens)}`);
	lines.push(`- Input: ${fmtInt(result.total.input)}`);
	lines.push(`- Output: ${fmtInt(result.total.output)}`);
	lines.push(`- Cache read: ${fmtInt(result.total.cacheRead)}`);
	lines.push(`- Cache write: ${fmtInt(result.total.cacheWrite)}`);
	lines.push(`- Cost: ${fmtCost(result.total.cost)}`);
	lines.push(`- Assistant messages with usage: ${fmtInt(result.total.assistantMessages)}`);
	lines.push("");
	lines.push("## Breakdown");
	if (result.rows.length === 0) {
		lines.push("No usage-bearing assistant messages found.");
		return lines.join("\n");
	}
	for (const row of result.rows) {
		const label = row.kind === "parent"
			? "parent"
			: `subagent ${row.runId ?? "<unknown>"}${row.runIndex ? `/${row.runIndex}` : ""}`;
		lines.push(`- ${label}: ${fmtInt(row.totalTokens)} tokens, ${fmtCost(row.cost)}, ${row.assistantMessages} assistant msgs`);
		lines.push(`  - ${row.path}`);
	}
	return lines.join("\n");
}

export default function sessionUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("session-usage-all", {
		description: "Show current session usage including subagent child sessions",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const result = collectSessionUsage(sessionFile);
			ctx.ui.notify(formatUsageReport(result), "info");
		},
	});

	pi.registerTool({
		name: "session_usage_all",
		label: "Session Usage All",
		description: "Calculate current session token/cost usage including subagent child sessions stored under the parent session directory.",
		promptSnippet: "Show total token/cost usage for current session including subagents",
		promptGuidelines: [
			"Use session_usage_all when the user asks total spend, cost, or token usage including subagents for the current session.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const result = collectSessionUsage(sessionFile);
			return {
				content: [{ type: "text", text: formatUsageReport(result) }],
				details: result,
			};
		},
	});
}
