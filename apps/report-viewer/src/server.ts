import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";

export type ReportSource = "json" | "legacy-markdown";
export type ImprovementStatus = "proposed" | "approved" | "rejected" | "running" | "completed" | "failed";

export interface ReportViewerConfig {
	reportRoots: string[];
	agentCommand: {
		bin: string;
		args: string[];
		promptMode?: "stdin";
	};
	host: string;
	port: number;
	csrfToken: string;
}

export interface ReportSummary {
	viewerReportId: string;
	extensionReportId: string;
	source: ReportSource;
	task: string;
	status: string;
	phase?: string;
	artifactDir: string;
	updatedAt: number;
}

export interface LoadedReport extends ReportSummary {
	structuredReport?: any;
	summaryMarkdown?: string;
	summaryHtml?: string;
	artifacts: Array<{ label: string; path: string; external: boolean }>;
}

export interface RetroImprovement {
	id: string;
	title: string;
	description: string;
	sourceArtifact?: string;
	sourceText?: string;
	risk: "low" | "medium" | "high";
	status: ImprovementStatus;
	createdAt: string;
	approvedAt?: string | null;
	rejectedAt?: string | null;
	approvalNote?: string | null;
}

export interface AgentRunRecord {
	id: string;
	improvementId: string;
	status: "running" | "completed" | "failed" | "unknown";
	commandArgv: string[];
	cwd: string;
	startedAt: string;
	endedAt?: string | null;
	exitCode?: number | null;
	outputLogPath: string;
	resultSummary?: string | null;
}

const DEFAULT_PORT = 8765;

export function expandHome(value: string): string {
	return value
		.replace(/^~(?=$|\/)/, os.homedir())
		.replace(/\$\{home\}/g, os.homedir());
}

function splitEnvList(value: string | undefined): string[] | undefined {
	const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
	return items?.length ? items : undefined;
}

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions", "report-viewer.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, configPath = defaultConfigPath()): ReportViewerConfig {
	let fileConfig: Partial<ReportViewerConfig> & { agentCommand?: { bin?: string; args?: string[]; promptMode?: string } } = {};
	if (fs.existsSync(configPath)) {
		fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
	}
	const reportRoots = splitEnvList(env.REPORT_VIEWER_ROOTS)
		?? fileConfig.reportRoots
		?? ["~/.pi/delivery-run"];
	const agentBin = env.REPORT_VIEWER_AGENT_BIN ?? fileConfig.agentCommand?.bin ?? "pi";
	const agentArgs = fileConfig.agentCommand?.args ?? [];
	const rawPromptMode = env.REPORT_VIEWER_AGENT_PROMPT_MODE ?? fileConfig.agentCommand?.promptMode;
	const promptMode = rawPromptMode === "stdin" ? rawPromptMode : undefined;
	const csrfToken = env.REPORT_VIEWER_CSRF_TOKEN ?? fileConfig.csrfToken ?? randomBytes(24).toString("base64url");
	return {
		reportRoots: reportRoots.map(expandHome),
		agentCommand: { bin: agentBin, args: agentArgs, promptMode },
		host: env.REPORT_VIEWER_HOST ?? fileConfig.host ?? "127.0.0.1",
		port: Number(env.REPORT_VIEWER_PORT ?? fileConfig.port ?? DEFAULT_PORT),
		csrfToken,
	};
}

function base64UrlEncode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
	return Buffer.from(value, "base64url").toString("utf8");
}

export function makeViewerReportId(rootIndex: number, relativeReportDirectory: string): string {
	return base64UrlEncode(`${rootIndex}:${relativeReportDirectory || "."}`);
}

export function parseViewerReportId(viewerReportId: string): { rootIndex: number; relativeReportDirectory: string } {
	const decoded = base64UrlDecode(viewerReportId);
	const separator = decoded.indexOf(":");
	if (separator === -1) throw new Error("Invalid report id");
	const rootIndex = Number(decoded.slice(0, separator));
	if (!Number.isInteger(rootIndex) || rootIndex < 0) throw new Error("Invalid report id root index");
	return { rootIndex, relativeReportDirectory: decoded.slice(separator + 1) };
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function readJsonIfPresent(filePath: string): any | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function reportSourceForDir(dir: string): ReportSource | undefined {
	if (fs.existsSync(path.join(dir, "delivery-report.json"))) return "json";
	if (fs.existsSync(path.join(dir, "00-delivery-summary.md"))) return "legacy-markdown";
	return undefined;
}

function reportMtime(dir: string): number {
	const jsonPath = path.join(dir, "delivery-report.json");
	const markdownPath = path.join(dir, "00-delivery-summary.md");
	const target = fs.existsSync(jsonPath) ? jsonPath : markdownPath;
	return fs.existsSync(target) ? fs.statSync(target).mtimeMs : fs.statSync(dir).mtimeMs;
}

function legacyTaskFromMarkdown(markdown: string, fallback: string): string {
	const match = /^Task:\s*(.+)$/m.exec(markdown);
	return match?.[1]?.trim() || fallback;
}

function summaryFromDir(rootIndex: number, root: string, dir: string): ReportSummary | undefined {
	const source = reportSourceForDir(dir);
	if (!source) return undefined;
	const relative = path.relative(root, dir) || ".";
	const viewerReportId = makeViewerReportId(rootIndex, relative);
	const fallbackTask = path.basename(dir);
	if (source === "json") {
		const structured = readJsonIfPresent(path.join(dir, "delivery-report.json"));
		return {
			viewerReportId,
			extensionReportId: String(structured?.id ?? fallbackTask),
			source,
			task: String(structured?.task ?? fallbackTask),
			status: String(structured?.status ?? structured?.phase ?? "unknown"),
			phase: structured?.phase ? String(structured.phase) : undefined,
			artifactDir: dir,
			updatedAt: Number(structured?.updatedAt ?? reportMtime(dir)),
		};
	}
	const markdownPath = path.join(dir, "00-delivery-summary.md");
	const markdown = fs.readFileSync(markdownPath, "utf8");
	const status = /^Status:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? "legacy";
	return {
		viewerReportId,
		extensionReportId: fallbackTask,
		source,
		task: legacyTaskFromMarkdown(markdown, fallbackTask),
		status,
		artifactDir: dir,
		updatedAt: reportMtime(dir),
	};
}

export function scanReports(config: Pick<ReportViewerConfig, "reportRoots">): ReportSummary[] {
	const reports: ReportSummary[] = [];
	config.reportRoots.forEach((configuredRoot, rootIndex) => {
		const root = path.resolve(expandHome(configuredRoot));
		if (!isDirectory(root)) return;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			const summary = summaryFromDir(rootIndex, root, dir);
			if (summary) reports.push(summary);
		}
	});
	return reports.sort((a, b) => b.updatedAt - a.updatedAt || a.viewerReportId.localeCompare(b.viewerReportId));
}

function reportDirForId(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): { root: string; dir: string } {
	const { rootIndex, relativeReportDirectory } = parseViewerReportId(viewerReportId);
	const configuredRoot = config.reportRoots[rootIndex];
	if (!configuredRoot) throw new Error("Unknown report root");
	const root = path.resolve(expandHome(configuredRoot));
	const candidate = path.resolve(root, relativeReportDirectory);
	const rootReal = fs.realpathSync(root);
	const candidateReal = fs.realpathSync(candidate);
	if (!isPathInside(candidateReal, rootReal)) throw new Error("Report directory escapes configured root");
	return { root: rootReal, dir: candidateReal };
}

function artifactListFromStructured(structured: any): Array<{ label: string; path: string; external: boolean }> {
	const artifacts = new Map<string, { label: string; path: string; external: boolean }>();
	for (const step of Array.isArray(structured?.steps) ? structured.steps : []) {
		if (!step?.artifact || typeof step.artifact !== "string") continue;
		const external = isExternalUrl(step.artifact);
		const label = `${step.phase ?? "artifact"}${step.attempt ? ` #${step.attempt}` : ""}`;
		artifacts.set(step.artifact, { label, path: step.artifact, external });
	}
	return [...artifacts.values()];
}

function conventionalArtifacts(dir: string): Array<{ label: string; path: string; external: boolean }> {
	return [
		"00-delivery-summary.md",
		"01-implementation.md",
		"02-verification.md",
		"03-review.md",
		"04-close.md",
		"05-retro.md",
	]
		.filter((name) => fs.existsSync(path.join(dir, name)))
		.map((name) => ({ label: name, path: name, external: false }));
}

export function loadReport(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): LoadedReport {
	const { root, dir } = reportDirForId(config, viewerReportId);
	const summary = summaryFromDir(Number(parseViewerReportId(viewerReportId).rootIndex), root, dir);
	if (!summary) throw new Error("Report not found");
	const markdownPath = path.join(dir, "00-delivery-summary.md");
	const summaryMarkdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, "utf8") : undefined;
	const structuredReport = readJsonIfPresent(path.join(dir, "delivery-report.json"));
	return {
		...summary,
		structuredReport,
		summaryMarkdown,
		summaryHtml: summaryMarkdown ? renderMarkdownSafe(summaryMarkdown) : undefined,
		artifacts: [...artifactListFromStructured(structuredReport), ...conventionalArtifacts(dir)],
	};
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function renderMarkdownSafe(markdown: string): string {
	return `<pre class="markdown-report">${escapeHtml(markdown)}</pre>`;
}

function isExternalUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function isPathInside(candidateRealPath: string, allowedRealPath: string): boolean {
	const relative = path.relative(allowedRealPath, candidateRealPath);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function containsTraversal(rawPath: string): boolean {
	const decoded = decodeURIComponent(rawPath);
	return decoded.split(/[\\/]+/).includes("..");
}

export function resolveArtifactPath(
	config: Pick<ReportViewerConfig, "reportRoots">,
	viewerReportId: string,
	artifactPath: string,
): { kind: "external"; url: string } | { kind: "local"; path: string } {
	if (isExternalUrl(artifactPath)) return { kind: "external", url: artifactPath };
	if (containsTraversal(artifactPath)) throw new Error("Artifact path traversal is not allowed");
	const { dir } = reportDirForId(config, viewerReportId);
	const allowedRoots = [dir, ...config.reportRoots.map((root) => fs.realpathSync(path.resolve(expandHome(root))))];
	const candidate = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(dir, artifactPath);
	if (!fs.existsSync(candidate)) throw new Error("Artifact not found");
	const realCandidate = fs.realpathSync(candidate);
	if (!allowedRoots.some((allowedRoot) => isPathInside(realCandidate, allowedRoot))) {
		throw new Error("Artifact path escapes configured report roots");
	}
	if (!fs.statSync(realCandidate).isFile()) throw new Error("Artifact is not a file");
	return { kind: "local", path: realCandidate };
}

function metadataDir(reportDir: string): string {
	return path.join(reportDir, ".report-viewer");
}

function readJsonArray<T>(filePath: string): T[] {
	if (!fs.existsSync(filePath)) return [];
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArrayAtomic<T>(filePath: string, value: T[]) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	fs.renameSync(tmpPath, filePath);
}

function improvementsPath(reportDir: string): string {
	return path.join(metadataDir(reportDir), "improvements.json");
}

function runsPath(reportDir: string): string {
	return path.join(metadataDir(reportDir), "agent-runs.json");
}

function reconcileStaleRunningRecordsForDir(reportDir: string) {
	const runFile = runsPath(reportDir);
	const improvementFile = improvementsPath(reportDir);
	const runs = readJsonArray<AgentRunRecord>(runFile);
	const improvements = readJsonArray<RetroImprovement>(improvementFile);
	let runsChanged = false;
	let improvementsChanged = false;
	const now = new Date().toISOString();
	for (const run of runs) {
		if (run.status !== "running") continue;
		run.status = "unknown";
		run.endedAt = now;
		run.resultSummary = "Marked unknown on report-viewer startup; no live child process is tracked after restart.";
		runsChanged = true;
		const improvement = improvements.find((item) => item.id === run.improvementId && item.status === "running");
		if (improvement) {
			improvement.status = "failed";
			improvementsChanged = true;
		}
	}
	if (runsChanged) writeJsonArrayAtomic(runFile, runs);
	if (improvementsChanged) writeJsonArrayAtomic(improvementFile, improvements);
}

export function reconcileStaleRunningRecords(config: Pick<ReportViewerConfig, "reportRoots">): number {
	let reconciled = 0;
	for (const report of scanReports(config)) {
		const { dir } = reportDirForId(config, report.viewerReportId);
		const before = readJsonArray<AgentRunRecord>(runsPath(dir)).filter((run) => run.status === "running").length;
		reconcileStaleRunningRecordsForDir(dir);
		reconciled += before;
	}
	return reconciled;
}

export function listImprovements(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): RetroImprovement[] {
	const { dir } = reportDirForId(config, viewerReportId);
	return readJsonArray<RetroImprovement>(improvementsPath(dir));
}

export function createImprovement(
	config: Pick<ReportViewerConfig, "reportRoots">,
	viewerReportId: string,
	input: Pick<RetroImprovement, "title" | "description"> & Partial<RetroImprovement>,
): RetroImprovement {
	const { dir } = reportDirForId(config, viewerReportId);
	const improvements = readJsonArray<RetroImprovement>(improvementsPath(dir));
	const now = new Date().toISOString();
	const improvement: RetroImprovement = {
		id: input.id ?? `imp_${Date.now().toString(36)}`,
		title: input.title,
		description: input.description,
		sourceArtifact: input.sourceArtifact,
		sourceText: input.sourceText,
		risk: input.risk ?? "low",
		status: "proposed",
		createdAt: now,
		approvedAt: null,
		rejectedAt: null,
		approvalNote: null,
	};
	improvements.push(improvement);
	writeJsonArrayAtomic(improvementsPath(dir), improvements);
	return improvement;
}

export function decideImprovement(
	config: Pick<ReportViewerConfig, "reportRoots">,
	viewerReportId: string,
	improvementId: string,
	decision: "approved" | "rejected",
	note?: string,
): RetroImprovement {
	const { dir } = reportDirForId(config, viewerReportId);
	const improvements = readJsonArray<RetroImprovement>(improvementsPath(dir));
	const improvement = improvements.find((item) => item.id === improvementId);
	if (!improvement) throw new Error("Improvement not found");
	if (improvement.status !== "proposed" && improvement.status !== "approved") {
		throw new Error(`Cannot decide improvement in status ${improvement.status}`);
	}
	const now = new Date().toISOString();
	improvement.status = decision;
	improvement.approvalNote = note ?? null;
	if (decision === "approved") improvement.approvedAt = now;
	else improvement.rejectedAt = now;
	writeJsonArrayAtomic(improvementsPath(dir), improvements);
	return improvement;
}

export function buildAgentPrompt(report: LoadedReport, improvement: RetroImprovement): string {
	return [
		"Implement this approved retro improvement.",
		"",
		`Delivery report JSON: ${path.join(report.artifactDir, "delivery-report.json")}`,
		`Delivery summary Markdown: ${path.join(report.artifactDir, "00-delivery-summary.md")}`,
		`Task: ${report.task}`,
		`Improvement: ${improvement.title}`,
		"",
		improvement.description,
		"",
		"Scope boundaries:",
		"- Address only this approved retro improvement.",
		"- Avoid unrelated cleanup or product changes.",
		"- Use a dedicated git worktree from latest main when repository work is applicable.",
		"",
		"Validation expectations:",
		"- Run focused checks relevant to the changed files.",
		"- Report changed files, commands run, validation output, and residual risks.",
	].join("\n");
}

export function runApprovedImprovement(
	config: ReportViewerConfig,
	viewerReportId: string,
	improvementId: string,
	options: { confirmExecution?: boolean } = {},
): AgentRunRecord {
	const report = loadReport(config, viewerReportId);
	const { dir } = reportDirForId(config, viewerReportId);
	reconcileStaleRunningRecordsForDir(dir);
	const improvements = readJsonArray<RetroImprovement>(improvementsPath(dir));
	const improvement = improvements.find((item) => item.id === improvementId);
	if (!improvement) throw new Error("Improvement not found");
	if (improvement.status !== "approved") throw new Error("Only approved improvements can be run");
	if (options.confirmExecution !== true) throw new Error("Explicit execution confirmation is required");
	if (config.agentCommand.promptMode !== "stdin") {
		throw new Error("Agent execution is disabled until agentCommand.promptMode is set to 'stdin' after confirming the local pi CLI supports non-interactive stdin prompts");
	}
	if (readJsonArray<AgentRunRecord>(runsPath(dir)).some((run) => run.improvementId === improvementId && run.status === "running")) {
		throw new Error("Improvement already has an active run");
	}
	const cwd = report.structuredReport?.gitRoot ?? report.structuredReport?.cwd;
	if (!cwd || !isDirectory(cwd)) throw new Error("Report has no usable gitRoot/cwd for agent execution");
	const runId = `run_${Date.now().toString(36)}`;
	const runsDir = path.join(metadataDir(dir), "runs");
	fs.mkdirSync(runsDir, { recursive: true });
	const logPath = path.join(runsDir, `${runId}.log`);
	const promptPath = path.join(runsDir, `${runId}-prompt.md`);
	const prompt = buildAgentPrompt(report, improvement);
	fs.writeFileSync(promptPath, prompt, "utf8");
	const argv = [config.agentCommand.bin, ...config.agentCommand.args];
	const record: AgentRunRecord = {
		id: runId,
		improvementId,
		status: "running",
		commandArgv: argv,
		cwd,
		startedAt: new Date().toISOString(),
		endedAt: null,
		exitCode: null,
		outputLogPath: path.relative(dir, logPath),
		resultSummary: null,
	};
	const runs = readJsonArray<AgentRunRecord>(runsPath(dir));
	runs.push(record);
	writeJsonArrayAtomic(runsPath(dir), runs);
	improvement.status = "running";
	writeJsonArrayAtomic(improvementsPath(dir), improvements);

	const child = spawn(config.agentCommand.bin, config.agentCommand.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	const log = fs.createWriteStream(logPath, { flags: "a" });
	let finished = false;
	function finishRun(status: "completed" | "failed", code: number | null, summary: string | null = null) {
		if (finished) return;
		finished = true;
		const latestRuns = readJsonArray<AgentRunRecord>(runsPath(dir));
		const latestRun = latestRuns.find((item) => item.id === runId);
		if (latestRun) {
			latestRun.status = status;
			latestRun.exitCode = code;
			latestRun.endedAt = new Date().toISOString();
			latestRun.resultSummary = summary;
			writeJsonArrayAtomic(runsPath(dir), latestRuns);
		}
		const latestImprovements = readJsonArray<RetroImprovement>(improvementsPath(dir));
		const latestImprovement = latestImprovements.find((item) => item.id === improvementId);
		if (latestImprovement) {
			latestImprovement.status = status;
			writeJsonArrayAtomic(improvementsPath(dir), latestImprovements);
		}
		log.end();
	}
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	child.stdin.end(prompt);
	child.on("error", (error) => {
		log.write(`\nSpawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
		finishRun("failed", null, "Agent process failed to start");
	});
	child.on("exit", (code) => finishRun(code === 0 ? "completed" : "failed", code));
	return record;
}

async function readRequestJson(request: http.IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body, null, 2));
}

function sendHtml(response: http.ServerResponse, body: string) {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(body);
}

function sendText(response: http.ServerResponse, body: string) {
	response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
	response.end(body);
}

function requireCsrfToken(request: http.IncomingMessage, config: Pick<ReportViewerConfig, "csrfToken">) {
	const token = request.headers["x-report-viewer-token"];
	if (token !== config.csrfToken) throw new Error("Missing or invalid report viewer CSRF token");
}

function page(title: string, body: string, config: Pick<ReportViewerConfig, "csrfToken">): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="report-viewer-csrf-token" content="${escapeHtml(config.csrfToken)}"><style>body{font-family:sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}pre{background:#f6f8fa;padding:1rem;overflow:auto}.status{font-weight:bold}.muted{color:#666}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left}</style></head><body>${body}</body></html>`;
}

function indexHtml(config: Pick<ReportViewerConfig, "csrfToken">): string {
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p><a href="/reports">Open report dashboard</a></p><p class="muted">API: <a href="/api/reports">/api/reports</a></p>`, config);
}

function reportsHtml(config: ReportViewerConfig): string {
	const rows = scanReports(config).map((report) => `<tr><td><a href="/reports/${encodeURIComponent(report.viewerReportId)}">${escapeHtml(report.task)}</a></td><td>${escapeHtml(report.status)}</td><td>${escapeHtml(report.source)}</td><td>${escapeHtml(new Date(report.updatedAt).toISOString())}</td><td><code>${escapeHtml(report.artifactDir)}</code></td></tr>`).join("");
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><table><thead><tr><th>Task</th><th>Status</th><th>Source</th><th>Updated</th><th>Artifact directory</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No reports found.</td></tr>`}</tbody></table>`, config);
}

function reportHtml(config: ReportViewerConfig, viewerReportId: string): string {
	const report = loadReport(config, viewerReportId);
	const artifacts = report.artifacts.map((artifact) => artifact.external
		? `<li><a href="${escapeHtml(artifact.path)}" rel="noreferrer">${escapeHtml(artifact.label)}</a> <span class="muted">external</span></li>`
		: `<li><a href="/reports/${encodeURIComponent(viewerReportId)}/artifacts/${encodeURIComponent(artifact.path)}">${escapeHtml(artifact.label)}</a> <code>${escapeHtml(artifact.path)}</code></li>`).join("");
	const steps = Array.isArray(report.structuredReport?.steps) ? report.structuredReport.steps : [];
	const stepRows = steps.map((step: any) => `<tr><td>${escapeHtml(String(step.phase ?? ""))}</td><td>${escapeHtml(String(step.attempt ?? ""))}</td><td>${escapeHtml(String(step.status ?? ""))}</td><td>${escapeHtml(String(step.verdict ?? ""))}</td><td>${escapeHtml(String(step.summary ?? ""))}</td></tr>`).join("");
	return page(report.task, `<p><a href="/reports">← Reports</a></p><h1>${escapeHtml(report.task)}</h1><p class="status">${escapeHtml(report.status)}${report.phase ? ` / ${escapeHtml(report.phase)}` : ""}</p><p><strong>Source:</strong> ${escapeHtml(report.source)}</p><p><strong>Artifact directory:</strong> <code>${escapeHtml(report.artifactDir)}</code></p><h2>Phase timeline</h2>${stepRows ? `<table><thead><tr><th>Phase</th><th>Attempt</th><th>Status</th><th>Verdict</th><th>Summary</th></tr></thead><tbody>${stepRows}</tbody></table>` : `<p class="muted">No structured steps available.</p>`}<h2>Artifacts</h2><ul>${artifacts || `<li>No artifacts found.</li>`}</ul><h2>Summary Markdown</h2>${report.summaryHtml ?? `<p class="muted">No Markdown summary found.</p>`}<h2>Raw JSON</h2><pre>${escapeHtml(JSON.stringify(report.structuredReport ?? null, null, 2))}</pre>`, config);
}

function artifactHtml(config: ReportViewerConfig, viewerReportId: string, artifactPath: string): string {
	const resolved = resolveArtifactPath(config, viewerReportId, artifactPath);
	if (resolved.kind === "external") {
		return page("External artifact", `<p><a href="/reports/${encodeURIComponent(viewerReportId)}">← Report</a></p><p>External artifact: <a href="${escapeHtml(resolved.url)}" rel="noreferrer">${escapeHtml(resolved.url)}</a></p>`, config);
	}
	const text = fs.readFileSync(resolved.path, "utf8");
	return page(path.basename(resolved.path), `<p><a href="/reports/${encodeURIComponent(viewerReportId)}">← Report</a></p><h1>${escapeHtml(path.basename(resolved.path))}</h1><p><code>${escapeHtml(resolved.path)}</code></p>${renderMarkdownSafe(text)}`, config);
}

export function createServer(config = loadConfig()): http.Server {
	reconcileStaleRunningRecords(config);
	return http.createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
			const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (request.method === "GET" && url.pathname === "/") return sendHtml(response, indexHtml(config));
			if (request.method === "GET" && url.pathname === "/reports") return sendHtml(response, reportsHtml(config));
			if (segments[0] === "reports" && segments[1]) {
				const reportId = segments[1];
				if (request.method === "GET" && segments.length === 2) return sendHtml(response, reportHtml(config, reportId));
				if (request.method === "GET" && segments[2] === "artifacts") return sendHtml(response, artifactHtml(config, reportId, segments.slice(3).join("/")));
			}
			if (request.method === "GET" && url.pathname === "/api/reports") return sendJson(response, 200, scanReports(config));
			if (segments[0] === "api" && segments[1] === "reports" && segments[2]) {
				const reportId = segments[2];
				if (request.method === "GET" && segments.length === 3) return sendJson(response, 200, loadReport(config, reportId));
				if (request.method === "GET" && segments[3] === "artifacts") {
					const artifactPath = segments.slice(4).join("/");
					const resolved = resolveArtifactPath(config, reportId, artifactPath);
					if (resolved.kind === "external") return sendJson(response, 400, { error: "External artifacts are not proxied", url: resolved.url });
					return sendText(response, fs.readFileSync(resolved.path, "utf8"));
				}
				if (segments[3] === "improvements") {
					if (request.method === "GET" && segments.length === 4) return sendJson(response, 200, listImprovements(config, reportId));
					if (request.method === "POST") requireCsrfToken(request, config);
					if (request.method === "POST" && segments.length === 4) return sendJson(response, 201, createImprovement(config, reportId, await readRequestJson(request)));
					const improvementId = segments[4];
					if (request.method === "POST" && segments[5] === "approve") return sendJson(response, 200, decideImprovement(config, reportId, improvementId, "approved", (await readRequestJson(request)).note));
					if (request.method === "POST" && segments[5] === "reject") return sendJson(response, 200, decideImprovement(config, reportId, improvementId, "rejected", (await readRequestJson(request)).note));
					if (request.method === "POST" && segments[5] === "preview-prompt") {
						const report = loadReport(config, reportId);
						const improvement = listImprovements(config, reportId).find((item) => item.id === improvementId);
						if (!improvement) throw new Error("Improvement not found");
						return sendJson(response, 200, { prompt: buildAgentPrompt(report, improvement) });
					}
					if (request.method === "POST" && segments[5] === "run") {
						const body = await readRequestJson(request);
						return sendJson(response, 202, runApprovedImprovement(config, reportId, improvementId, { confirmExecution: body.confirmExecution }));
					}
				}
			}
			return sendJson(response, 404, { error: "Not found" });
		} catch (error) {
			return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	});
}

if ((import.meta as any).main) {
	const config = loadConfig();
	createServer(config).listen(config.port, config.host, () => {
		console.log(`Report viewer listening on http://${config.host}:${config.port}`);
	});
}
