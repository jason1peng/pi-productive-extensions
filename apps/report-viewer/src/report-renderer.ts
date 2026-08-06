import { escapeHtml } from "./markdown-renderer.ts";
import { REPORT_VIEWER_CSS } from "./report-theme.ts";

export function badgeClass(value: string | undefined): string {
	const normalized = (value ?? "").toLowerCase();
	if (["done", "pass", "passed", "mr_created", "completed"].some((item) => normalized.includes(item))) return "ok";
	if (["fail", "failed", "blocked", "error"].some((item) => normalized.includes(item))) return "bad";
	if (["running", "waiting", "inconclusive"].some((item) => normalized.includes(item))) return "warn";
	return "";
}

export function page(title: string, body: string, config: Pick<{ csrfToken: string }, "csrfToken">): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="report-viewer-csrf-token" content="${escapeHtml(config.csrfToken)}"><style>${REPORT_VIEWER_CSS}</style></head><body>${body}</body></html>`;
}
