import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionUsageSnapshot, collectSessionUsage, type CollectedSessionUsage, type SessionUsageSnapshot, type UsageTotals } from "../../shared/session-usage.ts";

function fmtInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function fmtCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function formatUsageReport(result: CollectedSessionUsage): string {
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

function collectCurrentSessionUsage(sessionFile: string | undefined): CollectedSessionUsage {
	return collectSessionUsage(sessionFile, { childFileName: "session.jsonl" });
}

interface SessionManagerLike {
	getSessionFile(): string | undefined;
}

let activeSessionManager: SessionManagerLike | undefined;

function captureSessionManager(ctx: { sessionManager?: SessionManagerLike } | undefined): void {
	if (ctx && ctx.sessionManager) activeSessionManager = ctx.sessionManager;
}

function resetSessionUsageState(): void {
	activeSessionManager = undefined;
}

const SESSION_USAGE_REQUEST_EVENT = "session-usage:request";
const SESSION_USAGE_RESPONSE_EVENT = "session-usage:response";
const CHILD_SESSION_FILE = "session.jsonl";

function handleSessionUsageRequest(requestId: string, sessionFile: string | undefined): SessionUsageSnapshot {
	return buildSessionUsageSnapshot(sessionFile, { childFileName: CHILD_SESSION_FILE, requestId });
}

export const sessionUsageInternals = {
	collectCurrentSessionUsage,
	formatUsageReport,
	captureSessionManager,
	resetSessionUsageState,
	handleSessionUsageRequest,
	SESSION_USAGE_REQUEST_EVENT,
	SESSION_USAGE_RESPONSE_EVENT,
};

export type { CollectedSessionUsage, SessionUsageSnapshot, UsageTotals };

export default function sessionUsageExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		captureSessionManager(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		captureSessionManager(ctx);
	});
	pi.on("session_shutdown", () => {
		resetSessionUsageState();
	});

	pi.events.on(SESSION_USAGE_REQUEST_EVENT, (data) => {
		if (!data || typeof data !== "object") return;
		const request = data as { requestId?: unknown };
		if (typeof request.requestId !== "string") return;
		const sessionFile = activeSessionManager?.getSessionFile();
		const snapshot = handleSessionUsageRequest(request.requestId, sessionFile);
		pi.events.emit(SESSION_USAGE_RESPONSE_EVENT, snapshot);
	});

	pi.registerCommand("session-usage-all", {
		description: "Show current session usage including subagent child sessions",
		handler: async (_args, ctx) => {
			captureSessionManager(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			const result = collectCurrentSessionUsage(sessionFile);
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
			captureSessionManager(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			const result = collectCurrentSessionUsage(sessionFile);
			return {
				content: [{ type: "text", text: formatUsageReport(result) }],
				details: result,
			};
		},
	});
}
