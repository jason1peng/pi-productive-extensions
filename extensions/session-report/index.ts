import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectSessionReport,
	formatSessionReport,
	writeSessionReportArtifacts,
	type SessionReport,
	type SessionReportArtifactPaths,
} from "../../shared/session-report.ts";

interface SessionManagerLike {
	getSessionFile(): string | undefined;
}

export interface SessionReportToolDetails extends SessionReport {
	artifacts: SessionReportArtifactPaths | null;
}

let activeSessionManager: SessionManagerLike | undefined;

function captureSessionManager(ctx: { sessionManager?: SessionManagerLike } | undefined): void {
	if (ctx?.sessionManager) activeSessionManager = ctx.sessionManager;
}

function resetSessionReportState(): void {
	activeSessionManager = undefined;
}

function collectCurrentSessionReport(sessionFile: string | undefined): SessionReport {
	return collectSessionReport(sessionFile);
}

function createReportDetails(sessionFile: string | undefined): SessionReportToolDetails {
	const report = collectCurrentSessionReport(sessionFile);
	let artifacts: SessionReportArtifactPaths | null = null;
	try {
		artifacts = writeSessionReportArtifacts(report, {}, sessionFile);
	} catch {
		// The report itself is still useful when a private artifact directory is
		// temporarily unavailable. Never expose filesystem/error details in the
		// report or turn an artifact failure into fabricated usage values.
	}
	return { ...report, artifacts };
}

export const sessionReportInternals = {
	captureSessionManager,
	resetSessionReportState,
	collectCurrentSessionReport,
	createReportDetails,
	formatSessionReport,
};

export type { SessionReport };

export default function sessionReportExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		captureSessionManager(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		captureSessionManager(ctx);
	});
	pi.on("session_shutdown", () => {
		resetSessionReportState();
	});

	pi.registerCommand("session-report", {
		description: "Generate a deterministic local session report from persisted parent and delegated child JSONL",
		handler: async (_args, ctx) => {
			captureSessionManager(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			const details = createReportDetails(sessionFile);
			const message = details.artifacts
				? `${formatSessionReport(details)}\n\nPrivate artifacts:\n- JSON: ${details.artifacts.jsonPath}\n- Markdown: ${details.artifacts.markdownPath}`
				: `${formatSessionReport(details)}\n\nArtifact write unavailable; the report was not persisted.`;
			ctx.ui.notify(message, details.artifacts ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: "session_report",
		label: "Session Report",
		description: "Generate a deterministic versioned report of persisted session usage, topology, tool calls/results, and skill evidence.",
		promptSnippet: "Generate a deterministic report of current session activity and usage",
		promptGuidelines: [
			"Use session_report when the user asks for an expanded local session report including tools, skills, or delegated-session topology.",
			"This report reads persisted local JSONL only and never scans GitLab or includes raw prompts, arguments, messages, or secrets.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			captureSessionManager(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			const details = createReportDetails(sessionFile);
			return {
				content: [{ type: "text", text: formatSessionReport(details) }],
				details,
			};
		},
	});
}
