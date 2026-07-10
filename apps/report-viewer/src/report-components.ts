import * as fs from "node:fs";
import * as path from "node:path";
import { DELIVERY_PHASES } from "../../../shared/delivery-profile-config.ts";
import type { DeliveryReportJsonV2, DeliveryReportStep } from "../../../shared/delivery-report.ts";
import type { UsageTotals } from "../../../shared/session-usage.ts";
import { parseArtifactContract, type ParsedArtifact, type RetroCandidate } from "./artifact-contract.ts";
import { escapeHtml, renderMarkdownSafe } from "./markdown-renderer.ts";
import { badgeClass, page } from "./report-renderer.ts";
import { buildArtifactPageViewModel, buildReportDetailPageViewModel, buildReportListPageViewModel, compactTaskTitle, type DeliveryProfilePanelViewModel, type DeliveryProfileStateViewModel, type ReportDetailPageViewModel, type ReportListPageViewModel } from "./report-view-model.ts";
import type { AgentRunRecord, LoadedReport, ProjectReportGroup, ReportSummary, ReportViewerConfig, RetroImprovement } from "./server.ts";

export type ArtifactResolution =
	| { kind: "external"; url: string }
	| { kind: "local"; path: string }
	| { kind: "missing"; message: string }
	| { kind: "blocked"; message: string };

export interface ReportPageDataSource {
	scanReports(config: Pick<ReportViewerConfig, "reportRoots">): ReportSummary[];
	loadDeliveryProfileState(): DeliveryProfileStateViewModel;
	loadReport(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): LoadedReport;
	listImprovements(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): RetroImprovement[];
	readJsonIfPresent<T = unknown>(filePath: string): T | undefined;
	readJsonArray<T>(filePath: string): T[];
	improvementsPath(reportDir: string): string;
	runsPath(reportDir: string): string;
	artifactReferences(value: unknown): string[];
	artifactResolution(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifactPath: string): ArtifactResolution;
	resolveArtifactPath(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifactPath: string): { kind: "external"; url: string } | { kind: "local"; path: string };
}

let activeDataSource: ReportPageDataSource | undefined;

function withDataSource<T>(dataSource: ReportPageDataSource, render: () => T): T {
	const previous = activeDataSource;
	activeDataSource = dataSource;
	try {
		return render();
	} finally {
		activeDataSource = previous;
	}
}

function dataSource(): ReportPageDataSource {
	if (!activeDataSource) throw new Error("Report page data source is not configured.");
	return activeDataSource;
}

function scanReports(config: Pick<ReportViewerConfig, "reportRoots">): ReportSummary[] { return dataSource().scanReports(config); }
function loadDeliveryProfileState(): DeliveryProfileStateViewModel { return dataSource().loadDeliveryProfileState(); }
function loadReport(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): LoadedReport { return dataSource().loadReport(config, viewerReportId); }
function listImprovements(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): RetroImprovement[] { return dataSource().listImprovements(config, viewerReportId); }
function readJsonIfPresent<T = unknown>(filePath: string): T | undefined { return dataSource().readJsonIfPresent<T>(filePath); }
function readJsonArray<T>(filePath: string): T[] { return dataSource().readJsonArray<T>(filePath); }
function improvementsPath(reportDir: string): string { return dataSource().improvementsPath(reportDir); }
function runsPath(reportDir: string): string { return dataSource().runsPath(reportDir); }
function artifactReferences(value: unknown): string[] { return dataSource().artifactReferences(value); }
function artifactResolution(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifactPath: string): ArtifactResolution { return dataSource().artifactResolution(config, viewerReportId, artifactPath); }
function resolveArtifactPath(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifactPath: string): { kind: "external"; url: string } | { kind: "local"; path: string } { return dataSource().resolveArtifactPath(config, viewerReportId, artifactPath); }

function isExternalUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function containsTraversal(rawPath: string): boolean {
	const decoded = decodeURIComponent(rawPath);
	return decoded.split(/[\\/]+/).includes("..");
}

export function renderIndexPage(config: Pick<ReportViewerConfig, "csrfToken">, dataSource: ReportPageDataSource): string {
	return withDataSource(dataSource, () => indexHtml(config));
}

export function renderReportsPage(config: ReportViewerConfig, query: URLSearchParams, dataSource: ReportPageDataSource): string {
	return withDataSource(dataSource, () => reportsHtml(config, query));
}

export function renderReportPage(config: ReportViewerConfig, viewerReportId: string, dataSource: ReportPageDataSource): string {
	return withDataSource(dataSource, () => reportHtml(config, viewerReportId));
}

export function renderArtifactPage(config: ReportViewerConfig, viewerReportId: string, artifactPath: string, dataSource: ReportPageDataSource): string {
	return withDataSource(dataSource, () => artifactHtml(config, viewerReportId, artifactPath));
}

function indexHtml(config: Pick<ReportViewerConfig, "csrfToken">): string {
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p><a href="/reports">Open report dashboard</a></p><p class="muted">API: <a href="/api/reports">/api/reports</a></p>`, config);
}

interface ReportListSignal {
	label: string;
	badge: "ok" | "warn" | "bad" | "";
}

function stepPhase(step: DeliveryReportStep | undefined): string {
	return String(step?.phase ?? "").toUpperCase();
}

function stepArtifactLabel(step: DeliveryReportStep): string {
	const phase = String(step.phase ?? "artifact");
	const attempt = step.attempt ? ` #${step.attempt}` : "";
	if (step.agent === "aggregate") return `${phase}${attempt} aggregate`;
	if (step.childIndex !== undefined) {
		const child = Number(step.childIndex) + 1;
		const total = step.childCount ? `/${step.childCount}` : "";
		return `${phase}${attempt} reviewer ${child}${total}`;
	}
	return `${phase}${attempt}`;
}

function artifactResultVerdict(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifact: unknown): string | undefined {
	for (const ref of artifactReferences(artifact)) {
		try {
			const resolved = artifactResolution(config, viewerReportId, ref);
			if (resolved.kind !== "local") continue;
			const firstLine = fs.readFileSync(resolved.path, "utf8").split(/\r?\n/, 1)[0] ?? "";
			const verdict = /^RESULT:\s*([A-Z_]+)/i.exec(firstLine)?.[1]?.toUpperCase() ?? /^\s*(PASS_WITH_NON_BLOCKING_NOTES|PASS|FAIL|INCONCLUSIVE|DONE|MR_CREATED)\b/i.exec(firstLine)?.[1]?.toUpperCase();
			if (verdict) return verdict;
		} catch {
			// Ignore unreadable artifact verdict hints; the structured step status remains the fallback.
		}
	}
	return undefined;
}

function stepVerdict(step: DeliveryReportStep | undefined, config?: Pick<ReportViewerConfig, "reportRoots">, viewerReportId?: string): string {
	return String(step?.verdict ?? (config && viewerReportId ? artifactResultVerdict(config, viewerReportId, step?.artifact) : undefined) ?? step?.status ?? "unknown");
}

function retroCandidatesFromArtifact(reportDir: string, artifactPath = "05-retro.md"): RetroCandidate[] {
	if (path.isAbsolute(artifactPath) || containsTraversal(artifactPath)) return [];
	const retroPath = path.join(reportDir, artifactPath);
	try {
		if (!fs.existsSync(retroPath) || !fs.statSync(retroPath).isFile()) return [];
		return parseArtifactContract(fs.readFileSync(retroPath, "utf8"), { artifactPath, phase: "RETRO" }).retroCandidates;
	} catch {
		return [];
	}
}

function unsavedRetroCandidates(reportDir: string, improvements: RetroImprovement[], artifactPath = "05-retro.md"): RetroCandidate[] {
	const savedSourceTexts = new Set(improvements
		.filter((improvement) => improvement.sourceArtifact === artifactPath && improvement.sourceText)
		.map((improvement) => improvement.sourceText));
	return retroCandidatesFromArtifact(reportDir, artifactPath).filter((candidate) => !savedSourceTexts.has(candidate.sourceText));
}

function reportListSignals(config: Pick<ReportViewerConfig, "reportRoots">, report: ReportSummary): ReportListSignal[] {
	const structured = report.source === "json" ? readJsonIfPresent<DeliveryReportJsonV2>(path.join(report.artifactDir, "delivery-report.json")) : undefined;
	const steps: DeliveryReportStep[] = Array.isArray(structured?.steps) ? structured.steps : [];
	const failedQualitySteps = steps.filter((step) => ["VERIFY", "REVIEW"].includes(stepPhase(step)) && stepVerdict(step, config, report.viewerReportId).toUpperCase().includes("FAIL"));
	const acceptedRisks = Array.isArray(structured?.acceptedRisks) ? structured.acceptedRisks : [];
	const improvements = readJsonArray<RetroImprovement>(improvementsPath(report.artifactDir));
	const retroCandidates = unsavedRetroCandidates(report.artifactDir, improvements);
	const runs = readJsonArray<AgentRunRecord>(runsPath(report.artifactDir));
	const pendingImprovementIds = new Set<string>();
	for (const improvement of improvements) {
		if (["approved", "running"].includes(improvement.status)) pendingImprovementIds.add(improvement.id);
	}
	for (const run of runs) {
		if (run.status === "running") pendingImprovementIds.add(run.improvementId);
	}
	const signals: ReportListSignal[] = [];
	if (failedQualitySteps.length) {
		const failedLabels = failedQualitySteps.map((step) => `${stepPhase(step)} #${String(step.attempt ?? "?")}`).join(", ");
		signals.push({ label: `Failed verify/review: ${failedLabels}`, badge: "bad" });
	}
	if (acceptedRisks.length) signals.push({ label: `Accepted risks: ${acceptedRisks.length}`, badge: "warn" });
	if (improvements.length) signals.push({ label: `Retro improvements: ${improvements.length}`, badge: "warn" });
	if (retroCandidates.length) signals.push({ label: `Retro candidates: ${retroCandidates.length}`, badge: "warn" });
	if (pendingImprovementIds.size) signals.push({ label: `Pending improvement runs: ${pendingImprovementIds.size}`, badge: "warn" });
	return signals;
}

function reportSignalsHtml(config: Pick<ReportViewerConfig, "reportRoots">, report: ReportSummary): string {
	const signals = reportListSignals(config, report);
	if (!signals.length) return `<div class="muted">No risk or follow-up highlights.</div>`;
	return `<div class="signal-list" aria-label="Report highlights">${signals.map((signal) => `<span class="badge ${signal.badge}">${escapeHtml(signal.label)}</span>`).join(" ")}</div>`;
}

function launchSummaryHtml(launch: unknown): string {
	if (!launch || typeof launch !== "object" || Array.isArray(launch)) return `<code>${escapeHtml(JSON.stringify(launch))}</code>`;
	const record = launch as Record<string, unknown>;
	const parts = ["agent", "model", "thinking", "context"]
		.filter((key) => record[key] !== undefined)
		.map((key) => `<span><span class="label">${escapeHtml(key)}</span> <code>${escapeHtml(String(record[key]))}</code></span>`);
	return parts.length ? parts.join("<br>") : `<code>${escapeHtml(JSON.stringify(record))}</code>`;
}

function selectedProfileSetupHtml(state: DeliveryProfileStateViewModel): string {
	const definition = state.profileDefinitions[state.activeProfile];
	if (!definition) return `<p class="muted">No setup details available for selected profile.</p>`;
	const rows = DELIVERY_PHASES.map((phase) => {
		const phaseLaunch = definition[phase];
		const launchHtml = Array.isArray(phaseLaunch)
			? phaseLaunch.map((launch, index) => `<div><strong>${index + 1}.</strong> ${launchSummaryHtml(launch)}</div>`).join("")
			: launchSummaryHtml(phaseLaunch);
		return `<tr><th>${escapeHtml(phase)}</th><td>${launchHtml}</td></tr>`;
	}).join("");
	return `<details open><summary>Selected profile setup</summary><div class="wide-table"><table><tbody>${rows}</tbody></table></div></details>`;
}

function deliveryProfilePanelHtml(panel: DeliveryProfilePanelViewModel): string {
	if (panel.kind === "unavailable") {
		return `<section class="panel" id="delivery-profile"><h2>Delivery model profile</h2><p><span class="badge bad">Unavailable</span></p><p class="muted">${escapeHtml(panel.message)}</p></section>`;
	}
	const state = panel.state;
	const options = state.profiles.map((profile) => `<option value="${escapeHtml(profile)}" ${profile === state.activeProfile ? "selected" : ""}>${escapeHtml(profile)}</option>`).join("");
	const override = state.envOverride ? `<p><span class="badge warn">Environment override active</span> <span class="muted"><code>PI_DELIVERY_PROFILE=${escapeHtml(state.envProfile ?? "")}</code> is effective; saving here changes the global default for future runs without that env override.</span></p>` : "";
	return `<section class="panel" id="delivery-profile"><h2>Delivery model profile</h2><p>Active global profile: <span class="badge">${escapeHtml(state.activeProfile)}</span></p>${override}<form class="filters" id="delivery-profile-form"><label>Profile <select name="activeProfile">${options}</select></label><button type="submit">Switch global profile</button></form>${selectedProfileSetupHtml(state)}<p class="muted">Profiles are read from ${escapeHtml(state.definitionSource === "global-phase-launches" ? "global config" : "built-in defaults")}. This writes only <code>active-profile.json</code> under the pi agent directory; project files are never edited.</p><div class="muted" id="delivery-profile-message"></div><script>document.getElementById('delivery-profile-form')?.addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const message=document.getElementById('delivery-profile-message');const token=document.querySelector('meta[name="report-viewer-csrf-token"]').content;const activeProfile=form.elements.activeProfile.value;message.textContent='Saving…';const response=await fetch('/api/delivery-profiles/global/active',{method:'POST',headers:{'content-type':'application/json','x-report-viewer-token':token},body:JSON.stringify({activeProfile})});if(response.ok){const body=await response.json();message.textContent='Saved global profile: '+body.savedActiveProfile+(body.envOverride?' (environment override is still effective)':'');}else{const body=await response.json().catch(()=>({error:'Save failed'}));message.textContent='Save failed: '+body.error;}});</script></section>`;
}

function latestStepForPhase(steps: DeliveryReportStep[], phase: string): DeliveryReportStep | undefined {
	return [...steps].reverse().find((step) => stepPhase(step) === phase);
}

function reportBrief(config: Pick<ReportViewerConfig, "reportRoots">, report: ReportSummary): string {
	const structured = report.source === "json" ? readJsonIfPresent<DeliveryReportJsonV2>(path.join(report.artifactDir, "delivery-report.json")) : undefined;
	const steps: DeliveryReportStep[] = Array.isArray(structured?.steps) ? structured.steps : [];
	if (!steps.length) return report.source === "legacy-markdown" ? "Legacy Markdown report; open details for the summary." : "No structured phase steps recorded.";
	const failed = steps.filter((step) => ["VERIFY", "REVIEW"].includes(stepPhase(step)) && stepVerdict(step, config, report.viewerReportId).toUpperCase().includes("FAIL"));
	if (failed.length) return `Needs attention: ${failed.map((step) => `${stepPhase(step)} #${String(step.attempt ?? "?")}`).join(", ")} reported failure.`;
	const latestReview = latestStepForPhase(steps, "REVIEW");
	const latestVerify = latestStepForPhase(steps, "VERIFY");
	const latestImplement = latestStepForPhase(steps, "IMPLEMENT");
	const main = latestReview ?? latestVerify ?? latestImplement ?? steps.at(-1);
	const phase = stepPhase(main) || "STEP";
	const verdict = stepVerdict(main, config, report.viewerReportId);
	const attempts = steps.filter((step) => stepPhase(step) === phase).length;
	const repair = attempts > 1 ? ` after ${attempts} ${phase.toLowerCase()} attempts` : "";
	const summary = shortSummary(main?.summary);
	return `${phase} ${verdict}${repair}${summary ? ` — ${summary}` : ""}`;
}

function reportRowHtml(config: Pick<ReportViewerConfig, "reportRoots">, report: ReportSummary): string {
	const title = compactTaskTitle(report.task, report.extensionReportId);
	const href = `/reports/${encodeURIComponent(report.viewerReportId)}`;
	return `<article class="report-row"><div class="report-row-main"><a class="task-link report-title" href="${href}" title="${escapeHtml(report.task)}">${escapeHtml(title)}</a><div class="muted report-meta"><code>${escapeHtml(report.extensionReportId)}</code> · ${escapeHtml(new Date(report.updatedAt).toISOString())}</div><p class="report-brief">${escapeHtml(reportBrief(config, report))}</p>${reportSignalsHtml(config, report)}</div><div class="report-row-aside"><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span><span class="source-${escapeHtml(report.source)}">${escapeHtml(report.source === "json" ? "structured JSON" : "legacy Markdown")}</span><a class="button secondary" href="${href}">Open details</a></div></article>`;
}

function projectGroupHtml(config: Pick<ReportViewerConfig, "reportRoots">, group: ProjectReportGroup): string {
	const projectPath = group.projectRoot ?? group.gitRoot;
	const pathHtml = projectPath ? `<div>Path: <code>${escapeHtml(projectPath)}</code></div>` : "";
	const rootHtml = group.gitRoot && group.gitRoot !== projectPath ? `<div>Git root: <code>${escapeHtml(group.gitRoot)}</code></div>` : "";
	const remoteHtml = group.gitRemote ? `<div>Remote: <code>${escapeHtml(group.gitRemote)}</code></div>` : "";
	const detailsHtml = pathHtml || rootHtml || remoteHtml ? `<details class="project-metadata"><summary>Project metadata</summary><div class="muted">Project id: <code>${escapeHtml(group.projectId)}</code></div>${pathHtml}${rootHtml}${remoteHtml}</details>` : `<div class="muted">Project id: <code>${escapeHtml(group.projectId)}</code></div>`;
	const warningsHtml = group.warnings.length ? `<p>${group.warnings.map((warning) => `<span class="badge warn">${escapeHtml(warning)}</span>`).join(" ")}</p>` : "";
	const rows = group.reports.map((report) => reportRowHtml(config, report)).join("");
	return `<section class="section-card project-group" id="project-${escapeHtml(group.viewerProjectId)}"><div class="project-heading"><h2>${escapeHtml(group.projectName)}</h2><div class="muted">Visible runs: ${group.runCount} · Latest: ${escapeHtml(new Date(group.latestUpdatedAt).toISOString())}</div></div>${warningsHtml}${detailsHtml}<div class="report-list">${rows}</div></section>`;
}

function reportListPageViewModel(config: ReportViewerConfig, query = new URLSearchParams()): ReportListPageViewModel {
	try {
		return buildReportListPageViewModel({ reports: scanReports(config), query, profileState: loadDeliveryProfileState() });
	} catch (error) {
		return buildReportListPageViewModel({ reports: scanReports(config), query, profileError: error instanceof Error ? error.message : String(error) });
	}
}

function reportsHtml(config: ReportViewerConfig, query = new URLSearchParams()): string {
	const viewModel = reportListPageViewModel(config, query);
	const source = viewModel.query.source;
	const filterForm = `<form class="panel filters" method="get" action="/reports"><label>Status <input name="status" value="${escapeHtml(viewModel.query.status)}" placeholder="DONE, FAIL, REVIEW"></label><label>Source <select name="source"><option value="">Any</option><option value="json" ${source === "json" ? "selected" : ""}>JSON</option><option value="legacy-markdown" ${source === "legacy-markdown" ? "selected" : ""}>Legacy Markdown</option></select></label><label>Task search <input name="task" value="${escapeHtml(viewModel.query.task)}" placeholder="task text"></label><label>Recent days <input name="recentDays" type="number" min="1" value="${escapeHtml(viewModel.query.recentDays)}"></label><button type="submit">Apply filters</button><a class="button secondary" href="/reports">Reset</a></form>`;
	const groups = viewModel.groups.map((group) => projectGroupHtml(config, group)).join("");
	return page(viewModel.title, `<h1>Pi delivery reports</h1><p class="muted">Find reports by status, source, recency, or task text. Reports are grouped by project and shown as compact rows for easier scanning.</p>${deliveryProfilePanelHtml(viewModel.profilePanel)}${filterForm}<div class="project-groups">${groups || `<div class="panel">No reports found.</div>`}</div>`, config);
}

function formatUsageNumber(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "unavailable";
}

function formatUsageCost(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "unavailable";
}

function usageCardsHtml(usage: UsageTotals | undefined): string {
	return `<section id="usage-overview"><h2>Usage</h2><div class="grid"><div class="card"><div class="label">Total cost</div><div class="value">${escapeHtml(formatUsageCost(usage?.cost))}</div></div><div class="card"><div class="label">Total tokens</div><div class="value">${escapeHtml(formatUsageNumber(usage?.totalTokens))}</div></div><div class="card"><div class="label">Input tokens</div><div class="value">${escapeHtml(formatUsageNumber(usage?.input))}</div></div><div class="card"><div class="label">Output tokens</div><div class="value">${escapeHtml(formatUsageNumber(usage?.output))}</div></div><div class="card"><div class="label">Cache read tokens</div><div class="value">${escapeHtml(formatUsageNumber(usage?.cacheRead))}</div></div><div class="card"><div class="label">Cache write tokens</div><div class="value">${escapeHtml(formatUsageNumber(usage?.cacheWrite))}</div></div></div><p class="muted">Cost is shown only from total recorded session usage; cached input appears when usage records include cache read/write token fields.</p></section>`;
}

type UsageBreakdownMetric = "totalTokens" | "input" | "output" | "cost";

interface UsageBreakdownRow {
	phase: string;
	attemptLabel: string;
	agent: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

interface UsagePhaseSummary {
	phase: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const USAGE_BREAKDOWN_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777"];
const USAGE_METRIC_LABELS: Record<UsageBreakdownMetric, string> = {
	totalTokens: "Total tokens",
	input: "Input tokens",
	output: "Output tokens",
	cost: "Cost",
};

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageMetricValue(row: Pick<UsageBreakdownRow, UsageBreakdownMetric>, metric: UsageBreakdownMetric): number {
	return usageNumber(row[metric]);
}

function usageBreakdownRows(steps: DeliveryReportStep[]): UsageBreakdownRow[] {
	return steps.flatMap((step) => {
		const usage = step?.usageDelta;
		if (!usage) return [];
		const input = usageNumber(usage.input);
		const output = usageNumber(usage.output);
		const cacheRead = usageNumber(usage.cacheRead);
		const cacheWrite = usageNumber(usage.cacheWrite);
		const totalTokens = usageNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
		const cost = usageNumber(usage.cost);
		if (!totalTokens && !cost) return [];
		return [{
			phase: stepPhase(step) || "UNKNOWN",
			attemptLabel: stepArtifactLabel(step),
			agent: String(step?.agent ?? "default"),
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost,
		}];
	});
}

function usagePhaseSummaries(rows: UsageBreakdownRow[]): UsagePhaseSummary[] {
	const summaries = new Map<string, UsagePhaseSummary>();
	for (const row of rows) {
		const existing = summaries.get(row.phase) ?? { phase: row.phase, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
		existing.input += row.input;
		existing.output += row.output;
		existing.cacheRead += row.cacheRead;
		existing.cacheWrite += row.cacheWrite;
		existing.totalTokens += row.totalTokens;
		existing.cost += row.cost;
		summaries.set(row.phase, existing);
	}
	return [...summaries.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.phase.localeCompare(b.phase));
}

function percentOf(value: number, total: number): string {
	return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

function pieSlices(summary: UsagePhaseSummary[], metric: UsageBreakdownMetric): string {
	const total = summary.reduce((sum, row) => sum + usageMetricValue(row, metric), 0);
	if (total <= 0) return "#d0d5dd 0deg 360deg";
	let cursor = 0;
	return summary.map((row, index) => {
		const value = usageMetricValue(row, metric);
		const start = cursor;
		cursor += (value / total) * 360;
		return `${USAGE_BREAKDOWN_COLORS[index % USAGE_BREAKDOWN_COLORS.length]} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
	}).join(", ");
}

function usageBreakdownHtml(steps: DeliveryReportStep[]): string {
	const rows = usageBreakdownRows(steps);
	if (!rows.length) return `<section id="usage-breakdown" class="panel"><h2>Usage breakdown</h2><p class="muted">No per-step usage deltas are available for phase-level token analysis.</p></section>`;
	const summary = usagePhaseSummaries(rows);
	const metric: UsageBreakdownMetric = "totalTokens";
	const total = summary.reduce((sum, row) => sum + usageMetricValue(row, metric), 0);
	const maxTokens = Math.max(...summary.map((row) => row.totalTokens), 1);
	const phaseOptions = summary.map((row) => `<label><input type="checkbox" name="phase" value="${escapeHtml(row.phase)}" checked> ${escapeHtml(row.phase)}</label>`).join("");
	const metricOptions = (Object.keys(USAGE_METRIC_LABELS) as UsageBreakdownMetric[]).map((item) => `<option value="${item}" ${item === metric ? "selected" : ""}>${escapeHtml(USAGE_METRIC_LABELS[item])}</option>`).join("");
	const legend = summary.map((row, index) => `<span class="usage-legend-item" data-phase="${escapeHtml(row.phase)}"><span class="usage-swatch" style="background:${USAGE_BREAKDOWN_COLORS[index % USAGE_BREAKDOWN_COLORS.length]}"></span>${escapeHtml(row.phase)} ${escapeHtml(percentOf(usageMetricValue(row, metric), total))}</span>`).join("");
	const phaseRows = summary.map((row, index) => {
		const tokenWidth = Math.max(2, (row.totalTokens / maxTokens) * 100);
		const tokenTotal = row.totalTokens || row.input + row.output + row.cacheRead + row.cacheWrite || 1;
		return `<tr data-phase="${escapeHtml(row.phase)}" data-totalTokens="${row.totalTokens}" data-input="${row.input}" data-output="${row.output}" data-cost="${row.cost}"><td><span class="usage-swatch" style="background:${USAGE_BREAKDOWN_COLORS[index % USAGE_BREAKDOWN_COLORS.length]}"></span>${escapeHtml(row.phase)}</td><td>${escapeHtml(formatUsageNumber(row.totalTokens))}</td><td>${escapeHtml(formatUsageNumber(row.input))}</td><td>${escapeHtml(formatUsageNumber(row.output))}</td><td>${escapeHtml(formatUsageCost(row.cost))}</td><td><div class="usage-stack" title="input/output/cache"><span class="usage-stack-input" style="width:${(row.input / tokenTotal) * tokenWidth}%"></span><span class="usage-stack-output" style="width:${(row.output / tokenTotal) * tokenWidth}%"></span><span class="usage-stack-cache" style="width:${((row.cacheRead + row.cacheWrite) / tokenTotal) * tokenWidth}%"></span></div></td></tr>`;
	}).join("");
	const offenderRows = [...rows].sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost).slice(0, 5).map((row, index) => `<li data-phase="${escapeHtml(row.phase)}" data-totalTokens="${row.totalTokens}" data-input="${row.input}" data-output="${row.output}" data-cost="${row.cost}"><strong>${index + 1}. ${escapeHtml(row.attemptLabel)}</strong> — ${escapeHtml(formatUsageNumber(row.totalTokens))} tokens (${escapeHtml(percentOf(row.totalTokens, rows.reduce((sum, item) => sum + item.totalTokens, 0)))}) · input ${escapeHtml(formatUsageNumber(row.input))} / output ${escapeHtml(formatUsageNumber(row.output))} · ${escapeHtml(formatUsageCost(row.cost))} · ${escapeHtml(row.agent)}</li>`).join("");
	const data = escapeHtml(JSON.stringify(summary.map((row, index) => ({ ...row, color: USAGE_BREAKDOWN_COLORS[index % USAGE_BREAKDOWN_COLORS.length] }))));
	return `<section id="usage-breakdown" class="panel" data-usage-summary="${data}"><h2>Usage breakdown by phase</h2><p class="muted">Use this to identify whether delivery cost is dominated by a phase, by prompt input, by model output, or by repeated repair loops.</p><form class="filters" id="usage-breakdown-filters"><label>Metric <select name="metric">${metricOptions}</select></label><fieldset class="usage-phase-filter"><legend class="label">Phases</legend>${phaseOptions}</fieldset><button type="button" data-action="all">All phases</button><button type="button" data-action="none">No phases</button></form><div class="section-grid"><div class="card"><div class="label" id="usage-pie-title">${escapeHtml(USAGE_METRIC_LABELS[metric])} by phase</div><div class="usage-pie" role="img" aria-label="Pie chart of delivery usage by phase" style="background:conic-gradient(${escapeHtml(pieSlices(summary, metric))})"></div><div class="usage-legend">${legend}</div></div><div class="card"><div class="label">Top token offenders</div><ol class="usage-offenders">${offenderRows}</ol></div></div><div class="wide-table"><table id="usage-breakdown-table"><thead><tr><th>Phase</th><th>Total tokens</th><th>Input</th><th>Output</th><th>Cost</th><th>Input/output/cache bar</th></tr></thead><tbody>${phaseRows}</tbody></table></div><p class="muted">Stacked bars show input (blue), output (green), and cache read/write (amber) token proportions per phase. Percent labels and the pie chart update in-browser when filters change.</p>${usageBreakdownScriptHtml()}</section>`;
}

function usageBreakdownScriptHtml(): string {
	return `<script>(()=>{const section=document.getElementById('usage-breakdown');if(!section)return;const data=JSON.parse(section.dataset.usageSummary||'[]');const form=document.getElementById('usage-breakdown-filters');const pie=section.querySelector('.usage-pie');const title=document.getElementById('usage-pie-title');const labels={totalTokens:'Total tokens',input:'Input tokens',output:'Output tokens',cost:'Cost'};function enabled(){return new Set([...form.querySelectorAll('input[name="phase"]')].filter((input)=>input.checked).map((input)=>input.value));}function fmt(value,metric){return metric==='cost'?'$'+Number(value||0).toFixed(4):Math.round(Number(value||0)).toLocaleString('en-US');}function render(){const metric=form.elements.metric.value;const phases=enabled();const visible=data.filter((row)=>phases.has(row.phase));const total=visible.reduce((sum,row)=>sum+Number(row[metric]||0),0);let cursor=0;const slices=visible.map((row)=>{const start=cursor;cursor+=total>0?Number(row[metric]||0)/total*360:0;return row.color+' '+start.toFixed(2)+'deg '+cursor.toFixed(2)+'deg';});pie.style.background='conic-gradient('+(slices.length?slices.join(', '):'#d0d5dd 0deg 360deg')+')';title.textContent=labels[metric]+' by phase';section.querySelectorAll('[data-phase]').forEach((node)=>{const show=phases.has(node.dataset.phase);node.style.display=show?'':'none';});section.querySelectorAll('.usage-legend-item').forEach((node)=>{const row=data.find((item)=>item.phase===node.dataset.phase);const pct=total>0&&row?(Number(row[metric]||0)/total*100).toFixed(1):'0.0';node.lastChild.textContent=row.phase+' '+pct+'%';});}form.addEventListener('change',render);form.querySelector('[data-action="all"]').addEventListener('click',()=>{form.querySelectorAll('input[name="phase"]').forEach((input)=>input.checked=true);render();});form.querySelector('[data-action="none"]').addEventListener('click',()=>{form.querySelectorAll('input[name="phase"]').forEach((input)=>input.checked=false);render();});render();})();</script>`;
}

function phaseTokenUsage(step: DeliveryReportStep): string {
	return formatUsageNumber(step?.usageDelta?.totalTokens);
}

function phaseTokenDetail(step: DeliveryReportStep): string {
	const usage = step?.usageDelta;
	if (!usage) return "input unavailable / output unavailable / cache read unavailable / cache write unavailable";
	return `input ${formatUsageNumber(usage.input)} / output ${formatUsageNumber(usage.output)} / cache read ${formatUsageNumber(usage.cacheRead)} / cache write ${formatUsageNumber(usage.cacheWrite)}`;
}

function shortSummary(value: unknown): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function artifactHref(viewerReportId: string, artifact: string): string {
	return `/reports/${encodeURIComponent(viewerReportId)}/artifacts/${encodeURIComponent(artifact)}`;
}

function artifactLinkHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifact: string, label = "Open artifact/detail"): string {
	const resolved = artifactResolution(config, viewerReportId, artifact);
	if (resolved.kind === "external") return `<a href="${escapeHtml(resolved.url)}" rel="noreferrer">${escapeHtml(label)}</a>`;
	if (resolved.kind === "local") return `<a href="${artifactHref(viewerReportId, artifact)}">${escapeHtml(label)}</a>`;
	return `<span class="muted artifact-unavailable">${escapeHtml(label)} unavailable: ${escapeHtml(resolved.message)}</span>`;
}

function artifactLinksHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, artifact: unknown): string {
	const refs = artifactReferences(artifact);
	if (!refs.length) return `<span class="muted">No artifact link</span>`;
	const links = refs.map((ref, index) => {
		const label = refs.length > 1 ? `Artifact ${index + 1}` : "Open artifact/detail";
		return `<li>${artifactLinkHtml(config, viewerReportId, ref, label)}${refs.length > 1 ? ` <code>${escapeHtml(ref)}</code>` : ""}</li>`;
	}).join("");
	return `<ul class="artifact-links">${links}</ul>`;
}

function stepDisplaySummary(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, step: DeliveryReportStep): string {
	for (const ref of artifactReferences(step?.artifact)) {
		const resolved = artifactResolution(config, viewerReportId, ref);
		if (resolved.kind !== "local") continue;
		try {
			const parsed = parseArtifactContract(fs.readFileSync(resolved.path, "utf8"), { artifactPath: ref });
			if (parsed.summary) return parsed.summary;
		} catch {
			// Fall through to structured JSON summary.
		}
		break;
	}
	return shortSummary(step?.summary);
}

interface PhaseDisplaySummary {
	phase: string;
	attempts: number;
	verdicts: string[];
	summaries: string[];
}

function normalizedDisplayText(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function phaseDisplaySummaries(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: DeliveryReportStep[]): PhaseDisplaySummary[] {
	const summaries = new Map<string, PhaseDisplaySummary & { seenSummaries: Set<string>; seenVerdicts: Set<string> }>();
	for (const step of steps) {
		const phase = stepPhase(step) || "UNKNOWN";
		let phaseSummary = summaries.get(phase);
		if (!phaseSummary) {
			phaseSummary = { phase, attempts: 0, verdicts: [], summaries: [], seenSummaries: new Set(), seenVerdicts: new Set() };
			summaries.set(phase, phaseSummary);
		}
		phaseSummary.attempts += 1;
		const verdict = stepVerdict(step, config, viewerReportId);
		if (!phaseSummary.seenVerdicts.has(verdict)) {
			phaseSummary.seenVerdicts.add(verdict);
			phaseSummary.verdicts.push(verdict);
		}
		const summary = stepDisplaySummary(config, viewerReportId, step);
		const normalized = normalizedDisplayText(summary);
		if (normalized && !phaseSummary.seenSummaries.has(normalized)) {
			phaseSummary.seenSummaries.add(normalized);
			phaseSummary.summaries.push(summary);
		}
	}
	return [...summaries.values()].map(({ seenSummaries, seenVerdicts, ...summary }) => summary);
}

function phaseSummariesHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: DeliveryReportStep[]): string {
	const summaries = phaseDisplaySummaries(config, viewerReportId, steps);
	if (!summaries.length) return `<p class="muted">No structured phase summaries are available.</p>`;
	return `<div class="section-grid">${summaries.map((summary) => {
		const summaryCount = summary.summaries.length;
		const meta = `${summary.attempts} ${summary.attempts === 1 ? "attempt" : "attempts"} · ${summaryCount} unique ${summaryCount === 1 ? "summary" : "summaries"}`;
		const verdicts = summary.verdicts.map((verdict) => `<span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span>`).join(" ");
		const items = summary.summaries.length
			? `<ul>${summary.summaries.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
			: `<p class="muted">No summary recorded.</p>`;
		return `<article class="card phase-summary-card" data-phase="${escapeHtml(summary.phase)}" data-summary-count="${summaryCount}"><h3>${escapeHtml(summary.phase)}</h3><div class="phase-summary-meta"><span class="muted">${escapeHtml(meta)}</span> ${verdicts}</div>${items}</article>`;
	}).join("")}</div>`;
}

function phaseTimelineHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: DeliveryReportStep[]): string {
	if (!steps.length) return `<p class="muted">No structured timeline is available.</p>`;
	return `<ol class="phase-timeline" aria-label="Compact phase timeline">${steps.map((step) => {
		const verdict = stepVerdict(step, config, viewerReportId);
		const summary = stepDisplaySummary(config, viewerReportId, step);
		return `<li><div class="timeline-label"><strong>${escapeHtml(stepArtifactLabel(step))}</strong><span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span></div><div class="timeline-summary muted">${summary ? escapeHtml(summary) : "No summary"}</div></li>`;
	}).join("")}</ol>`;
}

function outcomeSummaryHtml(config: Pick<ReportViewerConfig, "reportRoots">, report: LoadedReport, steps: DeliveryReportStep[]): string {
	const failedQualitySteps = steps.filter((step) => ["VERIFY", "REVIEW"].includes(stepPhase(step)) && stepVerdict(step, config, report.viewerReportId).toUpperCase().includes("FAIL"));
	const latest = [...steps].reverse().find((step) => stepDisplaySummary(config, report.viewerReportId, step)) ?? steps.at(-1);
	const latestSummary = latest ? stepDisplaySummary(config, report.viewerReportId, latest) : "";
	const pendingIssue = report.structuredReport?.pendingIssue;
	const headline = pendingIssue
		? `Attention needed: ${String(pendingIssue.source ?? "pending issue")} reported ${String(pendingIssue.verdict ?? "issue")}`
		: failedQualitySteps.length
			? `Completed with attention: ${failedQualitySteps.length} failed verify/review ${failedQualitySteps.length === 1 ? "step" : "steps"}`
			: report.source === "json"
				? `Outcome: ${report.status}${report.phase && report.phase !== report.status ? ` (${report.phase})` : ""}`
				: `Outcome: ${report.status} legacy Markdown report`;
	const detail = pendingIssue?.summary ?? latestSummary ?? reportBrief(config, report);
	return `<section id="outcome-summary" class="panel outcome-summary"><h2>Outcome summary</h2><p class="outcome-line"><strong>${escapeHtml(headline)}</strong>${detail ? ` — ${escapeHtml(shortSummary(detail))}` : ""}</p><div class="signal-list"><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span><span class="badge">${escapeHtml(steps.length ? `${steps.length} phase steps` : "No phase steps")}</span>${failedQualitySteps.length ? `<span class="badge bad">${failedQualitySteps.length} failed quality gate${failedQualitySteps.length === 1 ? "" : "s"}</span>` : `<span class="badge ok">No failed quality gates</span>`}</div></section>`;
}

function pendingIssueSummaryHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, pendingIssue: unknown): string {
	if (!pendingIssue || typeof pendingIssue !== "object" || Array.isArray(pendingIssue)) return `<p class="muted">No pending issue.</p>`;
	const issue = pendingIssue as Record<string, unknown>;
	const artifact = typeof issue.artifact === "string" && issue.artifact.trim()
		? `<div>${artifactLinkHtml(config, viewerReportId, issue.artifact, "Open pending issue artifact")}</div>`
		: "";
	return `<div><strong>${escapeHtml(String(issue.source ?? "Pending issue"))}</strong> <span class="badge ${badgeClass(String(issue.verdict ?? ""))}">${escapeHtml(String(issue.verdict ?? "issue"))}</span></div><p>${escapeHtml(String(issue.summary ?? "No summary recorded."))}</p>${issue.recommendedDecision ? `<div class="muted">Recommended decision: ${escapeHtml(String(issue.recommendedDecision))}</div>` : ""}${artifact}`;
}

function attentionFollowUpsHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, acceptedRisks: unknown[], pendingIssue: unknown, improvements: RetroImprovement[], retroArtifact: { path: string } | undefined, retroCandidates: RetroCandidate[], steps: DeliveryReportStep[]): string {
	const risksHtml = acceptedRisks.length ? `<ul>${acceptedRisks.map((risk: unknown) => `<li>${escapeHtml(String(risk))}</li>`).join("")}</ul>` : `<p class="muted">No accepted risks recorded.</p>`;
	const improvementsHtml = improvements.length ? `<ul>${improvements.map((item) => `<li><strong>${escapeHtml(item.title)}</strong> <span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span><div class="muted">${escapeHtml(item.description)}</div></li>`).join("")}</ul>` : `<p class="muted">No app-owned retro improvements saved yet.</p>`;
	const retroCandidatesHtml = retroArtifact && retroCandidates.length ? retroCandidateHtml(viewerReportId, retroArtifact.path, retroCandidates) : `<p class="muted">No unsaved retro candidate rows found.</p>`;
	const retroLink = retroArtifact ? `<p>${artifactLinkHtml(config, viewerReportId, retroArtifact.path, "Open retro artifact")}</p>` : `<p class="muted">No retro artifact found.</p>`;
	return `<section id="attention-follow-ups" class="panel"><h2>Attention and follow-ups</h2><div class="attention-grid"><div class="attention-card"><h3>Failures and repairs</h3>${failureRepairHtml(config, viewerReportId, steps)}</div><div class="attention-card"><h3>Pending issue</h3>${pendingIssueSummaryHtml(config, viewerReportId, pendingIssue)}</div><div class="attention-card"><h3>Retro / follow-ups</h3>${retroLink}${improvementsHtml}</div><div class="attention-card"><h3>Accepted risks</h3>${risksHtml}</div></div>${retroCandidatesHtml}</section>`;
}

function phaseStepCardHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, step: DeliveryReportStep): string {
	const verdict = stepVerdict(step, config, viewerReportId);
	const summary = stepDisplaySummary(config, viewerReportId, step);
	return `<article class="phase-card"><div><strong>${escapeHtml(stepArtifactLabel(step))}</strong> <span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span></div><div class="muted">Agent: ${escapeHtml(String(step.agent ?? "default"))}</div><div class="summary">${summary ? escapeHtml(summary) : `<span class="muted">No summary recorded.</span>`}</div><div class="muted">Tokens: ${escapeHtml(phaseTokenUsage(step))}</div><div class="muted">${escapeHtml(phaseTokenDetail(step))}</div>${artifactLinksHtml(config, viewerReportId, step?.artifact)}</article>`;
}

function phaseJourneyHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: DeliveryReportStep[]): string {
	if (!steps.length) return `<div class="panel muted">No structured steps available.</div>`;
	const groupedSteps = new Map<string, DeliveryReportStep[]>();
	for (const step of steps) {
		const phase = stepPhase(step) || "UNKNOWN";
		const existing = groupedSteps.get(phase) ?? [];
		existing.push(step);
		groupedSteps.set(phase, existing);
	}
	const groups = [...groupedSteps.entries()].map(([phase, phaseSteps]) => {
		const repairNote = phaseSteps.length > 1 ? `<p class="muted">Repair loop: ${phaseSteps.length} attempts recorded.</p>` : "";
		return `<section class="section-card phase-group"><h3>${escapeHtml(phase)} attempts (${phaseSteps.length})</h3>${repairNote}<div class="phase-grid">${phaseSteps.map((step) => phaseStepCardHtml(config, viewerReportId, step)).join("")}</div></section>`;
	}).join("");
	return `${phaseTimelineHtml(config, viewerReportId, steps)}<details><summary>Phase attempt details</summary><div class="phase-groups">${groups}</div></details>`;
}

function failureRepairHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: DeliveryReportStep[]): string {
	const failures = steps.filter((step) => stepVerdict(step, config, viewerReportId).includes("FAIL") || String(step.summary ?? "").toLowerCase().includes("repair"));
	if (!failures.length) return `<p class="muted">No failed verification/review or repair loop is recorded.</p>`;
	return `<ul>${failures.map((step) => {
		const verdict = stepVerdict(step, config, viewerReportId);
		const summary = stepDisplaySummary(config, viewerReportId, step);
		return `<li><strong>${escapeHtml(stepArtifactLabel(step))}</strong>: <span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span> ${escapeHtml(summary)}</li>`;
	}).join("")}</ul>`;
}

function reportDetailPageViewModel(config: ReportViewerConfig, viewerReportId: string): ReportDetailPageViewModel {
	const report = loadReport(config, viewerReportId);
	const improvements = listImprovements(config, viewerReportId);
	const retroArtifact = report.artifacts.find((artifact) => !artifact.external && /05-retro\.md$/.test(artifact.path) && artifactResolution(config, viewerReportId, artifact.path).kind === "local");
	const retroCandidates = retroArtifact ? unsavedRetroCandidates(report.artifactDir, improvements, retroArtifact.path) : [];
	return buildReportDetailPageViewModel({ report, improvements, retroArtifact, retroCandidates });
}

function reportHtml(config: ReportViewerConfig, viewerReportId: string): string {
	const viewModel = reportDetailPageViewModel(config, viewerReportId);
	const { report, steps, usage, displayUsage, acceptedRisks, pendingIssue, improvements, retroArtifact, retroCandidates } = viewModel;
	const artifacts = report.artifacts.map((artifact) => `<li>${artifactLinkHtml(config, viewerReportId, artifact.path, artifact.label)}<div><code>${escapeHtml(artifact.path)}</code></div></li>`).join("");
	const sourceNote = report.source === "json"
		? `<p><span class="badge ok">Structured JSON source</span> <span class="muted">Rendered from <code>delivery-report.json</code>; raw JSON stays collapsed below.</span></p>`
		: `<div class="panel"><span class="badge warn">Legacy Markdown source</span><p class="muted">This run does not have <code>delivery-report.json</code>, so only limited metadata is available.</p></div>`;
	const cards = `<section id="overview"><h2>Overview</h2><div class="grid"><div class="card"><div class="label">Status</div><div class="value"><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span></div></div><div class="card"><div class="label">Phase</div><div class="value">${escapeHtml(report.phase ?? "—")}</div></div><div class="card"><div class="label">Source</div><div class="value">${escapeHtml(report.source === "json" ? "JSON" : "Markdown")}</div></div><div class="card"><div class="label">Updated</div><div class="value">${escapeHtml(new Date(report.updatedAt).toLocaleString())}</div></div></div><div class="panel"><div class="label">Artifact directory</div><code>${escapeHtml(report.artifactDir)}</code></div></section>`;
	const usageHtml = usage ? `<pre>${escapeHtml(JSON.stringify(usage, null, 2))}</pre>` : `<p class="muted">No structured usage data.</p>`;
	const pendingRawHtml = pendingIssue ? `<pre>${escapeHtml(JSON.stringify(pendingIssue, null, 2))}</pre>` : `<p class="muted">No pending issue.</p>`;
	const fullTaskDetails = viewModel.fullTask ? `<details class="full-task"><summary>Full delivery task</summary><p>${escapeHtml(viewModel.fullTask)}</p></details>` : "";
	const structuredDisplay = `<section id="phase-summaries"><h2>Phase summaries</h2>${phaseSummariesHtml(config, viewerReportId, steps)}</section><section id="phase-journey"><h2>Compact phase timeline</h2>${phaseJourneyHtml(config, viewerReportId, steps)}</section>`;
	return page(report.task, `<p><a href="/reports">← Reports</a></p><h1 title="${escapeHtml(report.task)}">${escapeHtml(viewModel.title)}</h1>${fullTaskDetails}${sourceNote}${outcomeSummaryHtml(config, report, steps)}${cards}${usageCardsHtml(displayUsage)}${usageBreakdownHtml(steps)}${structuredDisplay}${attentionFollowUpsHtml(config, viewerReportId, acceptedRisks, pendingIssue, improvements, retroArtifact, retroCandidates, steps)}<section id="artifacts"><h2>Artifacts</h2><ul class="artifact-list">${artifacts || `<li>No artifacts found.</li>`}</ul></section><section id="debug-details"><h2>Debug details</h2><details><summary>Usage JSON</summary>${usageHtml}</details><details><summary>Pending issue JSON</summary>${pendingRawHtml}</details><details><summary>Summary Markdown</summary>${report.summaryHtml ?? `<p class="muted">No Markdown summary found.</p>`}</details><details><summary>Raw structured JSON</summary><pre>${escapeHtml(JSON.stringify(report.structuredReport ?? null, null, 2))}</pre></details></section>`, config);
}

function sectionBodyHtml(body: string): string {
	if (!body.trim()) return `<p class="muted">none</p>`;
	return renderMarkdownSafe(body);
}

function structuredSectionsHtml(parsed: ParsedArtifact): string {
	if (!parsed.sections.length) return "";
	return `<div class="artifact-sections">${parsed.sections.map((section) => `<article class="section-card"><h2>${escapeHtml(section.heading)}</h2>${sectionBodyHtml(section.body)}</article>`).join("")}</div>`;
}

function sourceEvidenceHtml(viewerReportId: string, evidence: string): string {
	const artifactPattern = /(^|[\s([`])([A-Za-z0-9][A-Za-z0-9._/-]*\.md)(?=$|[\s)\]`,.;:])/g;
	let html = "";
	let lastIndex = 0;
	let linked = false;
	for (const match of evidence.matchAll(artifactPattern)) {
		const artifact = match[2];
		if (isExternalUrl(artifact) || path.isAbsolute(artifact) || containsTraversal(artifact)) continue;
		const artifactStart = (match.index ?? 0) + match[1].length;
		html += escapeHtml(evidence.slice(lastIndex, artifactStart));
		html += `<a href="${artifactHref(viewerReportId, artifact)}">${escapeHtml(artifact)}</a>`;
		lastIndex = artifactStart + artifact.length;
		linked = true;
	}
	if (!linked) return escapeHtml(evidence);
	html += escapeHtml(evidence.slice(lastIndex));
	return html;
}

function retroCandidateHtml(viewerReportId: string, artifactPath: string, candidates: RetroCandidate[]): string {
	if (!candidates.length) return "";
	const buttons = candidates.map((candidate) => {
		const payload = {
			title: candidate.title,
			description: candidate.suggestedAction,
			risk: candidate.severity,
			sourceArtifact: artifactPath,
			sourceText: candidate.sourceText,
		};
		return `<article class="phase-card"><div><strong>${escapeHtml(candidate.title)}</strong> <span class="badge ${badgeClass(candidate.severity)}">${escapeHtml(candidate.severity)}</span></div><p>${escapeHtml(candidate.suggestedAction)}</p><div class="muted">Evidence: ${sourceEvidenceHtml(viewerReportId, candidate.sourceEvidence)}</div><div class="candidate-actions"><button class="create-improvement" data-report="${escapeHtml(viewerReportId)}" data-payload="${escapeHtml(JSON.stringify(payload))}">Create improvement</button></div></article>`;
	}).join("");
	return `<section id="retro-candidates"><h2>Actionable improvement candidates</h2><div class="phase-grid">${buttons}</div><script>document.querySelectorAll('.create-improvement').forEach((button)=>button.addEventListener('click',async()=>{const token=document.querySelector('meta[name="report-viewer-csrf-token"]').content;const report=button.getAttribute('data-report');const payload=JSON.parse(button.getAttribute('data-payload'));button.disabled=true;const response=await fetch('/api/reports/'+encodeURIComponent(report)+'/improvements',{method:'POST',headers:{'content-type':'application/json','x-report-viewer-token':token},body:JSON.stringify(payload)});button.textContent=response.ok?'Improvement saved':'Save failed';}));</script></section>`;
}

function artifactPageViewModel(config: ReportViewerConfig, viewerReportId: string, artifactPath: string) {
	const resolved = resolveArtifactPath(config, viewerReportId, artifactPath);
	if (resolved.kind === "external") return buildArtifactPageViewModel({ viewerReportId, artifactPath, resolved });
	const text = fs.readFileSync(resolved.path, "utf8");
	return buildArtifactPageViewModel({ viewerReportId, artifactPath, resolved, text, parsed: parseArtifactContract(text, { artifactPath }) });
}

function artifactHtml(config: ReportViewerConfig, viewerReportId: string, artifactPath: string): string {
	const viewModel = artifactPageViewModel(config, viewerReportId, artifactPath);
	if (viewModel.kind === "external") {
		return page("External artifact", `<p><a href="/reports/${encodeURIComponent(viewerReportId)}">← Report</a></p><p>External artifact: <a href="${escapeHtml(viewModel.url)}" rel="noreferrer">${escapeHtml(viewModel.url)}</a></p>`, config);
	}
	const parsed = viewModel.parsed;
	const resultHeader = parsed.result ? `<span class="badge ${badgeClass(parsed.result)}">${escapeHtml(parsed.result)}</span>` : `<span class="badge warn">unparsed</span>`;
	const note = parsed.isContract ? "" : `<div class="panel structured-note"><strong>Structured parsing unavailable for this artifact.</strong><p class="muted">Showing best-effort sections and raw Markdown fallback.</p></div>`;
	const structured = parsed.sections.length ? structuredSectionsHtml(parsed) : renderMarkdownSafe(viewModel.text);
	return page(viewModel.title, `<p><a href="/reports/${encodeURIComponent(viewerReportId)}">← Report</a></p><h1>${escapeHtml(viewModel.title)} ${resultHeader}</h1><p><code>${escapeHtml(viewModel.path)}</code></p>${note}${retroCandidateHtml(viewerReportId, artifactPath, parsed.retroCandidates)}${structured}<details><summary>Raw Markdown</summary>${renderMarkdownSafe(viewModel.text)}</details>`, config);
}
