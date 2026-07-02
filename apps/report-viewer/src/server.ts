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
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function reportSourceForDir(dir: string): ReportSource | undefined {
	const jsonPath = path.join(dir, "delivery-report.json");
	if (fs.existsSync(jsonPath) && readJsonIfPresent(jsonPath) !== undefined) return "json";
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

function renderInlineMarkdownSafe(value: string): string {
	return escapeHtml(value)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
}

export function renderMarkdownSafe(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const html: string[] = [];
	let listOpen = false;
	let codeOpen = false;
	const closeList = () => {
		if (listOpen) {
			html.push("</ul>");
			listOpen = false;
		}
	};
	for (const line of lines) {
		if (/^```/.test(line.trim())) {
			closeList();
			if (codeOpen) html.push("</code></pre>");
			else html.push('<pre class="markdown-code"><code>');
			codeOpen = !codeOpen;
			continue;
		}
		if (codeOpen) {
			html.push(`${escapeHtml(line)}\n`);
			continue;
		}
		const trimmed = line.trim();
		if (!trimmed) {
			closeList();
			continue;
		}
		const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
		if (heading) {
			closeList();
			const level = Math.min(heading[1].length + 1, 5);
			html.push(`<h${level}>${renderInlineMarkdownSafe(heading[2])}</h${level}>`);
			continue;
		}
		const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
		if (bullet) {
			if (!listOpen) {
				html.push("<ul>");
				listOpen = true;
			}
			html.push(`<li>${renderInlineMarkdownSafe(bullet[1])}</li>`);
			continue;
		}
		closeList();
		html.push(`<p>${renderInlineMarkdownSafe(trimmed)}</p>`);
	}
	closeList();
	if (codeOpen) html.push("</code></pre>");
	return `<div class="markdown-doc">${html.join("\n")}</div>`;
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

export function listRuns(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string): AgentRunRecord[] {
	const { dir } = reportDirForId(config, viewerReportId);
	return readJsonArray<AgentRunRecord>(runsPath(dir));
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
	const cwd = reportExecutionCwd(report);
	if (!cwd) throw new Error("Report has no usable gitRoot/cwd for agent execution");
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
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="report-viewer-csrf-token" content="${escapeHtml(config.csrfToken)}"><style>:root{color-scheme:light dark;--bg:#f6f8fb;--panel:#fff;--text:#182230;--muted:#667085;--border:#d0d5dd;--accent:#2563eb;--ok:#067647;--warn:#b54708;--bad:#b42318}@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--panel:#111827;--text:#e5e7eb;--muted:#9ca3af;--border:#374151;--accent:#60a5fa;--ok:#32d583;--warn:#fdb022;--bad:#f97066}}*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);max-width:1180px;margin:0 auto;padding:2rem 1rem 4rem}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.panel,.card,details{background:var(--panel);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.04)}.panel{padding:1rem;margin:1rem 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:1rem 0}.card{padding:1rem}.label{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}.value{font-size:1.25rem;font-weight:700;margin-top:.25rem}.muted{color:var(--muted)}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:.2rem .55rem;font-size:.82rem;font-weight:700;background:#eef4ff;color:#3538cd}.badge.ok{background:#dcfae6;color:var(--ok)}.badge.warn{background:#fef0c7;color:var(--warn)}.badge.bad{background:#fee4e2;color:var(--bad)}table{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden}td,th{border-bottom:1px solid var(--border);padding:.65rem .75rem;text-align:left;vertical-align:top}tr:last-child td{border-bottom:0}th{font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}pre{background:rgba(127,127,127,.10);padding:1rem;overflow:auto;border-radius:10px}.markdown-report{max-height:520px}details{padding:.9rem 1rem;margin:1rem 0}summary{cursor:pointer;font-weight:700}.artifact-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.65rem;padding:0;list-style:none}.artifact-list li{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:.75rem}.task-link{font-weight:700}.source-json{color:var(--ok)}.source-legacy-markdown{color:var(--warn)}input,textarea,select,button{font:inherit}input,textarea,select{width:100%;margin:.25rem 0 .75rem;padding:.55rem;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text)}textarea{min-height:5rem}button{border:0;border-radius:8px;padding:.5rem .75rem;background:var(--accent);color:white;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed;background:var(--muted)}button.secondary{background:var(--muted)}button.danger{background:var(--bad)}.actions{display:flex;gap:.5rem;flex-wrap:wrap}.message{margin-top:.75rem}.action-note{flex-basis:100%;font-size:.85rem;color:var(--muted)}.phase-grid{display:grid;gap:1rem}.phase-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:1rem;box-shadow:0 1px 2px rgba(16,24,40,.04)}.phase-card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}.phase-title{display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.05rem}.phase-meta{color:var(--muted);font-size:.9rem}.phase-summary{margin:.8rem 0;line-height:1.45}.phase-actions{display:flex;gap:.5rem;flex-wrap:wrap}.button-link{display:inline-flex;align-items:center;border-radius:8px;padding:.45rem .7rem;background:var(--accent);color:white}.button-link:hover{text-decoration:none}.button-link.secondary{background:var(--muted)}.markdown-doc{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:1rem;line-height:1.5}.markdown-doc h2,.markdown-doc h3,.markdown-doc h4,.markdown-doc h5{margin:1rem 0 .5rem}.markdown-doc p{margin:.5rem 0}.markdown-doc ul{margin:.5rem 0 .75rem 1.25rem;padding:0}.markdown-code{white-space:pre-wrap}.summary-short{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}</style></head><body>${body}</body></html>`;
}

function indexHtml(config: Pick<ReportViewerConfig, "csrfToken">): string {
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p><a href="/reports">Open report dashboard</a></p><p class="muted">API: <a href="/api/reports">/api/reports</a></p>`, config);
}

function badgeClass(value: string | undefined): string {
	const normalized = (value ?? "").toLowerCase();
	if (["done", "pass", "passed", "mr_created", "completed"].some((item) => normalized.includes(item))) return "ok";
	if (["fail", "failed", "blocked", "error"].some((item) => normalized.includes(item))) return "bad";
	if (["running", "waiting", "inconclusive"].some((item) => normalized.includes(item))) return "warn";
	return "";
}

function reportsHtml(config: ReportViewerConfig): string {
	const rows = scanReports(config).map((report) => `<tr><td><a class="task-link" href="/reports/${encodeURIComponent(report.viewerReportId)}">${escapeHtml(report.task)}</a><div class="muted"><code>${escapeHtml(report.extensionReportId)}</code></div></td><td><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span></td><td><span class="source-${escapeHtml(report.source)}">${escapeHtml(report.source === "json" ? "structured JSON" : "legacy Markdown")}</span></td><td>${escapeHtml(new Date(report.updatedAt).toISOString())}</td><td><code>${escapeHtml(report.artifactDir)}</code></td></tr>`).join("");
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p class="muted">JSON-backed reports show structured status, phase timeline, artifacts, usage, risks, and pending issues. Legacy runs fall back to Markdown until converted or regenerated.</p><table><thead><tr><th>Task</th><th>Status</th><th>Source</th><th>Updated</th><th>Artifact directory</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No reports found.</td></tr>`}</tbody></table>`, config);
}

function reportExecutionCwd(report: LoadedReport): string | undefined {
	for (const candidate of [report.structuredReport?.gitRoot, report.structuredReport?.cwd]) {
		if (typeof candidate === "string" && isDirectory(candidate)) return candidate;
	}
	return undefined;
}

function runDisabledReason(config: ReportViewerConfig, report: LoadedReport, improvement: RetroImprovement): string | undefined {
	if (improvement.status !== "approved") return "Run is available only after this improvement is approved.";
	if (config.agentCommand.promptMode !== "stdin") return "Agent execution is disabled. Set REPORT_VIEWER_AGENT_PROMPT_MODE=stdin after confirming your local pi CLI supports non-interactive stdin prompts.";
	if (!reportExecutionCwd(report)) return "Agent execution needs a usable gitRoot or cwd from the structured report.";
	return undefined;
}

function truncateText(value: unknown, maxLength = 420): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function phaseDetailLink(viewerReportId: string, artifact: unknown): string {
	if (typeof artifact !== "string" || !artifact) return "";
	if (isExternalUrl(artifact)) return `<a class="button-link secondary" href="${escapeHtml(artifact)}" rel="noreferrer">Open details</a>`;
	return `<a class="button-link" href="/reports/${encodeURIComponent(viewerReportId)}/artifacts/${encodeURIComponent(artifact)}">Open details</a>`;
}

function phaseCardsHtml(viewerReportId: string, steps: any[]): string {
	if (!steps.length) return `<div class="panel muted">No structured steps available.</div>`;
	return `<div class="phase-grid">${steps.map((step: any) => {
		const verdict = String(step.verdict ?? step.status ?? "reported");
		const phase = String(step.phase ?? "phase");
		const attempt = step.attempt ? `#${escapeHtml(String(step.attempt))}` : "";
		const agent = step.agent ? ` · ${escapeHtml(String(step.agent))}` : "";
		const detailLink = phaseDetailLink(viewerReportId, step.artifact);
		return `<article class="phase-card"><div class="phase-card-head"><div><div class="phase-title"><span>${escapeHtml(phase)}</span><span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span></div><div class="phase-meta">${attempt}${agent}</div></div><div class="phase-actions">${detailLink}</div></div>${step.summary ? `<p class="phase-summary summary-short">${escapeHtml(truncateText(step.summary))}</p>` : `<p class="phase-summary muted">No structured summary recorded.</p>`}</article>`;
	}).join("")}</div>`;
}

function reportHtml(config: ReportViewerConfig, viewerReportId: string): string {
	const report = loadReport(config, viewerReportId);
	const improvements = listImprovements(config, viewerReportId);
	const runs = listRuns(config, viewerReportId);
	const artifacts = report.artifacts.map((artifact) => artifact.external
		? `<li><a href="${escapeHtml(artifact.path)}" rel="noreferrer">${escapeHtml(artifact.label)}</a><div class="muted">external</div></li>`
		: `<li><a href="/reports/${encodeURIComponent(viewerReportId)}/artifacts/${encodeURIComponent(artifact.path)}">${escapeHtml(artifact.label)}</a><div><code>${escapeHtml(artifact.path)}</code></div></li>`).join("");
	const steps = Array.isArray(report.structuredReport?.steps) ? report.structuredReport.steps : [];
	const phaseCards = phaseCardsHtml(viewerReportId, steps);
	const usage = report.structuredReport?.usage;
	const acceptedRisks = Array.isArray(report.structuredReport?.acceptedRisks) ? report.structuredReport.acceptedRisks : [];
	const pendingIssue = report.structuredReport?.pendingIssue;
	const sourceNote = report.source === "json"
		? `<p><span class="badge ok">Structured JSON source</span> <span class="muted">The dashboard below is rendered from <code>delivery-report.json</code>.</span></p>`
		: `<div class="panel"><span class="badge warn">Legacy Markdown source</span><p class="muted">This run does not have <code>delivery-report.json</code>, so only limited metadata is available. Run <code>npm run convert-report -- ${escapeHtml(report.artifactDir)}</code> to create best-effort JSON for this legacy report.</p></div>`;
	const cards = `<div class="grid"><div class="card"><div class="label">Status</div><div class="value"><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span></div></div><div class="card"><div class="label">Phase</div><div class="value">${escapeHtml(report.phase ?? "—")}</div></div><div class="card"><div class="label">Source</div><div class="value">${escapeHtml(report.source === "json" ? "JSON" : "Markdown")}</div></div><div class="card"><div class="label">Updated</div><div class="value">${escapeHtml(new Date(report.updatedAt).toLocaleString())}</div></div></div>`;
	const risksHtml = acceptedRisks.length ? `<ul>${acceptedRisks.map((risk: unknown) => `<li>${escapeHtml(String(risk))}</li>`).join("")}</ul>` : `<p class="muted">No accepted risks recorded.</p>`;
	const pendingHtml = pendingIssue ? `<pre>${escapeHtml(JSON.stringify(pendingIssue, null, 2))}</pre>` : `<p class="muted">No pending issue.</p>`;
	const usageHtml = usage ? `<pre>${escapeHtml(JSON.stringify(usage, null, 2))}</pre>` : `<p class="muted">No structured usage data.</p>`;
	const improvementRows = improvements.map((improvement) => {
		const disabledRunReason = runDisabledReason(config, report, improvement);
		const runDisabledAttrs = disabledRunReason ? ` disabled title="${escapeHtml(disabledRunReason)}"` : "";
		const approveDisabledAttrs = improvement.status !== "proposed" ? ` disabled title="Only proposed improvements can be approved."` : "";
		const rejectDisabledAttrs = !["proposed", "approved"].includes(improvement.status) ? ` disabled title="Only proposed or approved improvements can be rejected."` : "";
		const runGuidance = disabledRunReason ? `<div class="action-note">${escapeHtml(disabledRunReason)}</div>` : "";
		return `<tr><td><strong>${escapeHtml(improvement.title)}</strong><div class="muted">${escapeHtml(improvement.description)}</div>${improvement.sourceArtifact ? `<div><code>${escapeHtml(improvement.sourceArtifact)}</code></div>` : ""}</td><td>${escapeHtml(improvement.risk)}</td><td><span class="badge ${badgeClass(improvement.status)}">${escapeHtml(improvement.status)}</span></td><td class="actions"><button data-action="approve" data-id="${escapeHtml(improvement.id)}"${approveDisabledAttrs}>Approve</button><button class="secondary" data-action="reject" data-id="${escapeHtml(improvement.id)}"${rejectDisabledAttrs}>Reject</button><button class="secondary" data-action="preview" data-id="${escapeHtml(improvement.id)}">Preview prompt</button><button data-action="run" data-id="${escapeHtml(improvement.id)}"${runDisabledAttrs}>Run</button>${runGuidance}</td></tr>`;
	}).join("");
	const runRows = runs.map((run) => `<tr><td><code>${escapeHtml(run.id)}</code></td><td><code>${escapeHtml(run.improvementId)}</code></td><td><span class="badge ${badgeClass(run.status)}">${escapeHtml(run.status)}</span></td><td>${escapeHtml(run.startedAt)}</td><td>${escapeHtml(run.endedAt ?? "")}</td><td><code>${escapeHtml(run.outputLogPath)}</code></td></tr>`).join("");
	const improvementPanel = `<section class="panel"><h2>Retro improvements</h2><form id="improvement-form"><label>Title<input name="title" required></label><label>Description<textarea name="description" required></textarea></label><label>Source artifact<input name="sourceArtifact" placeholder="05-retro.md"></label><label>Risk<select name="risk"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label><button type="submit">Add improvement</button></form><div id="improvement-message" class="message muted"></div><table><thead><tr><th>Improvement</th><th>Risk</th><th>Status</th><th>Actions</th></tr></thead><tbody>${improvementRows || `<tr><td colspan="4">No improvements yet.</td></tr>`}</tbody></table></section>`;
	const runsPanel = `<section class="panel"><h2>Agent runs</h2><table><thead><tr><th>Run</th><th>Improvement</th><th>Status</th><th>Started</th><th>Ended</th><th>Log</th></tr></thead><tbody>${runRows || `<tr><td colspan="6">No runs yet.</td></tr>`}</tbody></table></section>`;
	const script = `<script>(()=>{const token=document.querySelector('meta[name="report-viewer-csrf-token"]').content;const reportId=${JSON.stringify(viewerReportId)};const msg=document.getElementById('improvement-message');async function post(url,body={}){const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-report-viewer-token':token},body:JSON.stringify(body)});const text=await res.text();let data;try{data=JSON.parse(text)}catch{data=text}if(!res.ok)throw new Error(data.error||text||res.statusText);return data}function note(text){msg.textContent=text}document.getElementById('improvement-form')?.addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);try{await post('/api/reports/'+encodeURIComponent(reportId)+'/improvements',Object.fromEntries(form.entries()));location.reload()}catch(error){note(error.message)}});document.querySelectorAll('button[data-action]').forEach((button)=>button.addEventListener('click',async()=>{const id=button.dataset.id;const action=button.dataset.action;try{if(action==='approve'||action==='reject'){await post('/api/reports/'+encodeURIComponent(reportId)+'/improvements/'+encodeURIComponent(id)+'/'+action,{note:'decided from report viewer UI'});location.reload()}else if(action==='preview'){const data=await post('/api/reports/'+encodeURIComponent(reportId)+'/improvements/'+encodeURIComponent(id)+'/preview-prompt',{});alert(data.prompt)}else if(action==='run'){if(!confirm('Run the approved pi agent for this improvement?'))return;await post('/api/reports/'+encodeURIComponent(reportId)+'/improvements/'+encodeURIComponent(id)+'/run',{confirmExecution:true});location.reload()}}catch(error){note(error.message)}}))})();</script>`;
	return page(report.task, `<p><a href="/reports">← Reports</a></p><h1>${escapeHtml(report.task)}</h1>${sourceNote}${cards}<div class="panel"><div class="label">Artifact directory</div><code>${escapeHtml(report.artifactDir)}</code></div><h2>Phases</h2>${phaseCards}<h2>Artifacts</h2><ul class="artifact-list">${artifacts || `<li>No artifacts found.</li>`}</ul><div class="grid"><div class="card"><h2>Accepted risks</h2>${risksHtml}</div><div class="card"><h2>Pending issue</h2>${pendingHtml}</div></div>${improvementPanel}${runsPanel}<details><summary>Usage JSON</summary>${usageHtml}</details><details><summary>Summary Markdown</summary>${report.summaryHtml ?? `<p class="muted">No Markdown summary found.</p>`}</details><details><summary>Raw structured JSON</summary><pre>${escapeHtml(JSON.stringify(report.structuredReport ?? null, null, 2))}</pre></details>${script}`, config);
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
				if (request.method === "GET" && segments[3] === "runs") return sendJson(response, 200, listRuns(config, reportId));
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
