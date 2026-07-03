import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import { parseArtifactContract, type ParsedArtifact, type RetroCandidate } from "./artifact-contract.ts";
import { escapeHtml, renderMarkdownSafe } from "./markdown-renderer.ts";
import { badgeClass, page } from "./report-renderer.ts";
export { escapeHtml, renderMarkdownSafe } from "./markdown-renderer.ts";

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

function stepArtifactLabel(step: any): string {
	const phase = String(step?.phase ?? "artifact");
	const attempt = step?.attempt ? ` #${step.attempt}` : "";
	if (step?.agent === "aggregate") return `${phase}${attempt} aggregate`;
	if (step?.childIndex !== undefined) {
		const child = Number(step.childIndex) + 1;
		const total = step.childCount ? `/${step.childCount}` : "";
		return `${phase}${attempt} reviewer ${child}${total}`;
	}
	return `${phase}${attempt}`;
}

function artifactListFromStructured(structured: any): Array<{ label: string; path: string; external: boolean }> {
	const artifacts = new Map<string, { label: string; path: string; external: boolean }>();
	for (const step of Array.isArray(structured?.steps) ? structured.steps : []) {
		if (!step?.artifact || typeof step.artifact !== "string") continue;
		const external = isExternalUrl(step.artifact);
		artifacts.set(step.artifact, { label: stepArtifactLabel(step), path: step.artifact, external });
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

function mergeArtifacts(...artifactLists: Array<Array<{ label: string; path: string; external: boolean }>>): Array<{ label: string; path: string; external: boolean }> {
	const artifacts = new Map<string, { label: string; path: string; external: boolean }>();
	for (const artifact of artifactLists.flat()) {
		if (!artifacts.has(artifact.path)) artifacts.set(artifact.path, artifact);
	}
	return [...artifacts.values()];
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
		artifacts: mergeArtifacts(artifactListFromStructured(structuredReport), conventionalArtifacts(dir)),
	};
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

function indexHtml(config: Pick<ReportViewerConfig, "csrfToken">): string {
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p><a href="/reports">Open report dashboard</a></p><p class="muted">API: <a href="/api/reports">/api/reports</a></p>`, config);
}

function filterReports(reports: ReportSummary[], query: URLSearchParams): ReportSummary[] {
	const status = query.get("status")?.trim().toLowerCase();
	const source = query.get("source")?.trim();
	const task = query.get("task")?.trim().toLowerCase();
	const recentDays = Number(query.get("recentDays") || 0);
	const since = recentDays > 0 ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : undefined;
	return reports.filter((report) => {
		if (status && !report.status.toLowerCase().includes(status)) return false;
		if (source && report.source !== source) return false;
		if (task && !`${report.task} ${report.extensionReportId}`.toLowerCase().includes(task)) return false;
		if (since && report.updatedAt < since) return false;
		return true;
	});
}

interface ReportListSignal {
	label: string;
	badge: "ok" | "warn" | "bad" | "";
}

function stepPhase(step: any): string {
	return String(step?.phase ?? "").toUpperCase();
}

function artifactResultVerdict(reportDir: string | undefined, artifact: unknown): string | undefined {
	if (!reportDir || typeof artifact !== "string" || isExternalUrl(artifact) || containsTraversal(artifact)) return undefined;
	try {
		const realReportDir = fs.realpathSync(reportDir);
		const candidate = path.isAbsolute(artifact) ? artifact : path.resolve(reportDir, artifact);
		if (!fs.existsSync(candidate)) return undefined;
		const realCandidate = fs.realpathSync(candidate);
		if (!isPathInside(realCandidate, realReportDir) || !fs.statSync(realCandidate).isFile()) return undefined;
		const firstLine = fs.readFileSync(realCandidate, "utf8").split(/\r?\n/, 1)[0] ?? "";
		return /^RESULT:\s*([A-Z_]+)/i.exec(firstLine)?.[1]?.toUpperCase() ?? /^\s*(PASS_WITH_NON_BLOCKING_NOTES|PASS|FAIL|INCONCLUSIVE|DONE|MR_CREATED)\b/i.exec(firstLine)?.[1]?.toUpperCase();
	} catch {
		return undefined;
	}
}

function stepVerdict(step: any, reportDir?: string): string {
	return String(step?.verdict ?? artifactResultVerdict(reportDir, step?.artifact) ?? step?.status ?? "unknown");
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

function reportListSignals(report: ReportSummary): ReportListSignal[] {
	const structured = report.source === "json" ? readJsonIfPresent(path.join(report.artifactDir, "delivery-report.json")) : undefined;
	const steps = Array.isArray(structured?.steps) ? structured.steps : [];
	const failedQualitySteps = steps.filter((step: any) => ["VERIFY", "REVIEW"].includes(stepPhase(step)) && stepVerdict(step).toUpperCase().includes("FAIL"));
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
		const failedLabels = failedQualitySteps.map((step: any) => `${stepPhase(step)} #${String(step.attempt ?? "?")}`).join(", ");
		signals.push({ label: `Failed verify/review: ${failedLabels}`, badge: "bad" });
	}
	if (acceptedRisks.length) signals.push({ label: `Accepted risks: ${acceptedRisks.length}`, badge: "warn" });
	if (improvements.length) signals.push({ label: `Retro improvements: ${improvements.length}`, badge: "warn" });
	if (retroCandidates.length) signals.push({ label: `Retro candidates: ${retroCandidates.length}`, badge: "warn" });
	if (pendingImprovementIds.size) signals.push({ label: `Pending improvement runs: ${pendingImprovementIds.size}`, badge: "warn" });
	return signals;
}

function reportSignalsHtml(report: ReportSummary): string {
	const signals = reportListSignals(report);
	if (!signals.length) return `<div class="muted">No risk or follow-up highlights.</div>`;
	return `<div class="signal-list" aria-label="Report highlights">${signals.map((signal) => `<span class="badge ${signal.badge}">${escapeHtml(signal.label)}</span>`).join(" ")}</div>`;
}

function reportsHtml(config: ReportViewerConfig, query = new URLSearchParams()): string {
	const reports = filterReports(scanReports(config), query);
	const source = query.get("source") ?? "";
	const filterForm = `<form class="panel filters" method="get" action="/reports"><label>Status <input name="status" value="${escapeHtml(query.get("status") ?? "")}" placeholder="DONE, FAIL, REVIEW"></label><label>Source <select name="source"><option value="">Any</option><option value="json" ${source === "json" ? "selected" : ""}>JSON</option><option value="legacy-markdown" ${source === "legacy-markdown" ? "selected" : ""}>Legacy Markdown</option></select></label><label>Task search <input name="task" value="${escapeHtml(query.get("task") ?? "")}" placeholder="task text"></label><label>Recent days <input name="recentDays" type="number" min="1" value="${escapeHtml(query.get("recentDays") ?? "")}"></label><button type="submit">Apply filters</button><a class="button secondary" href="/reports">Reset</a></form>`;
	const cards = reports.map((report) => `<article class="phase-card"><div><a class="task-link" href="/reports/${encodeURIComponent(report.viewerReportId)}">${escapeHtml(report.task)}</a><div class="muted"><code>${escapeHtml(report.extensionReportId)}</code></div></div><div><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span> <span class="source-${escapeHtml(report.source)}">${escapeHtml(report.source === "json" ? "structured JSON" : "legacy Markdown")}</span></div>${reportSignalsHtml(report)}<div class="muted">${escapeHtml(new Date(report.updatedAt).toISOString())}</div><details><summary>Artifact directory</summary><code>${escapeHtml(report.artifactDir)}</code></details></article>`).join("");
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p class="muted">Find reports by status, source, recency, or task text. Cards avoid wide table-heavy reading on mobile.</p>${filterForm}<div class="phase-grid">${cards || `<div class="panel">No reports found.</div>`}</div>`, config);
}

function phaseCost(step: any): string {
	const cost = step?.usageDelta?.cost;
	return typeof cost === "number" ? `$${cost.toFixed(4)}` : "unavailable";
}

function shortSummary(value: unknown): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function artifactHref(viewerReportId: string, artifact: string): string {
	return `/reports/${encodeURIComponent(viewerReportId)}/artifacts/${encodeURIComponent(artifact)}`;
}

function phaseStepCardHtml(viewerReportId: string, step: any, reportDir: string): string {
	const verdict = stepVerdict(step, reportDir);
	const artifact = typeof step.artifact === "string" ? step.artifact : "";
	return `<article class="phase-card"><div><strong>${escapeHtml(stepArtifactLabel(step))}</strong> <span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span></div><div class="muted">Agent: ${escapeHtml(String(step.agent ?? "default"))}</div><div class="summary">${escapeHtml(shortSummary(step.summary)) || `<span class="muted">No summary recorded.</span>`}</div><div class="muted">Cost: ${escapeHtml(phaseCost(step))}</div>${artifact ? `<a href="${artifactHref(viewerReportId, artifact)}">Open artifact/detail</a>` : `<span class="muted">No artifact link</span>`}</article>`;
}

function phaseJourneyHtml(viewerReportId: string, steps: any[], reportDir: string): string {
	if (!steps.length) return `<div class="panel muted">No structured steps available.</div>`;
	const groupedSteps = new Map<string, any[]>();
	for (const step of steps) {
		const phase = stepPhase(step) || "UNKNOWN";
		const existing = groupedSteps.get(phase) ?? [];
		existing.push(step);
		groupedSteps.set(phase, existing);
	}
	const groups = [...groupedSteps.entries()].map(([phase, phaseSteps]) => {
		const repairNote = phaseSteps.length > 1 ? `<p class="muted">Repair loop: ${phaseSteps.length} attempts recorded.</p>` : "";
		return `<section class="section-card phase-group"><h3>${escapeHtml(phase)} attempts (${phaseSteps.length})</h3>${repairNote}<div class="phase-grid">${phaseSteps.map((step) => phaseStepCardHtml(viewerReportId, step, reportDir)).join("")}</div></section>`;
	}).join("");
	return `<div class="section-grid phase-groups">${groups}</div>`;
}

function failureRepairHtml(steps: any[], reportDir: string): string {
	const failures = steps.filter((step) => stepVerdict(step, reportDir).includes("FAIL") || String(step.summary ?? "").toLowerCase().includes("repair"));
	if (!failures.length) return `<p class="muted">No failed verification/review or repair loop is recorded.</p>`;
	return `<ul>${failures.map((step) => {
		const verdict = stepVerdict(step, reportDir);
		return `<li><strong>${escapeHtml(stepArtifactLabel(step))}</strong>: <span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span> ${escapeHtml(shortSummary(step.summary))}</li>`;
	}).join("")}</ul>`;
}

function reportHtml(config: ReportViewerConfig, viewerReportId: string): string {
	const report = loadReport(config, viewerReportId);
	const artifacts = report.artifacts.map((artifact) => artifact.external
		? `<li><a href="${escapeHtml(artifact.path)}" rel="noreferrer">${escapeHtml(artifact.label)}</a><div class="muted">external</div></li>`
		: `<li><a href="${artifactHref(viewerReportId, artifact.path)}">${escapeHtml(artifact.label)}</a><div><code>${escapeHtml(artifact.path)}</code></div></li>`).join("");
	const steps = Array.isArray(report.structuredReport?.steps) ? report.structuredReport.steps : [];
	const usage = report.structuredReport?.usage;
	const acceptedRisks = Array.isArray(report.structuredReport?.acceptedRisks) ? report.structuredReport.acceptedRisks : [];
	const pendingIssue = report.structuredReport?.pendingIssue;
	const improvements = listImprovements(config, viewerReportId);
	const retroArtifact = report.artifacts.find((artifact) => !artifact.external && /05-retro\.md$/.test(artifact.path));
	const retroCandidates = retroArtifact ? unsavedRetroCandidates(report.artifactDir, improvements, retroArtifact.path) : [];
	const sourceNote = report.source === "json"
		? `<p><span class="badge ok">Structured JSON source</span> <span class="muted">Rendered from <code>delivery-report.json</code>; raw JSON stays collapsed below.</span></p>`
		: `<div class="panel"><span class="badge warn">Legacy Markdown source</span><p class="muted">This run does not have <code>delivery-report.json</code>, so only limited metadata is available.</p></div>`;
	const cards = `<section id="overview"><h2>Overview</h2><div class="grid"><div class="card"><div class="label">Status</div><div class="value"><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span></div></div><div class="card"><div class="label">Phase</div><div class="value">${escapeHtml(report.phase ?? "—")}</div></div><div class="card"><div class="label">Source</div><div class="value">${escapeHtml(report.source === "json" ? "JSON" : "Markdown")}</div></div><div class="card"><div class="label">Updated</div><div class="value">${escapeHtml(new Date(report.updatedAt).toLocaleString())}</div></div></div><div class="panel"><div class="label">Artifact directory</div><code>${escapeHtml(report.artifactDir)}</code></div></section>`;
	const risksHtml = acceptedRisks.length ? `<ul>${acceptedRisks.map((risk: unknown) => `<li>${escapeHtml(String(risk))}</li>`).join("")}</ul>` : `<p class="muted">No accepted risks recorded.</p>`;
	const improvementsHtml = improvements.length ? `<ul>${improvements.map((item) => `<li><strong>${escapeHtml(item.title)}</strong> <span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span><div class="muted">${escapeHtml(item.description)}</div></li>`).join("")}</ul>` : `<p class="muted">No app-owned retro improvements saved yet.</p>`;
	const retroCandidatesHtml = retroArtifact && retroCandidates.length ? retroCandidateHtml(viewerReportId, retroArtifact.path, retroCandidates) : `<p class="muted">No unsaved retro candidate rows found.</p>`;
	const pendingHtml = pendingIssue ? `<pre>${escapeHtml(JSON.stringify(pendingIssue, null, 2))}</pre>` : `<p class="muted">No pending issue.</p>`;
	const usageHtml = usage ? `<pre>${escapeHtml(JSON.stringify(usage, null, 2))}</pre>` : `<p class="muted">No structured usage data.</p>`;
	return page(report.task, `<p><a href="/reports">← Reports</a></p><h1>${escapeHtml(report.task)}</h1>${sourceNote}${cards}<section id="phase-journey"><h2>Phase journey</h2>${phaseJourneyHtml(viewerReportId, steps, report.artifactDir)}</section><section id="failures-and-repairs" class="panel"><h2>Failures and repairs</h2>${failureRepairHtml(steps, report.artifactDir)}${pendingHtml}</section><section id="retro-follow-ups" class="panel"><h2>Retro / follow-ups</h2>${retroArtifact ? `<p><a href="${artifactHref(viewerReportId, retroArtifact.path)}">Open retro artifact</a></p>` : `<p class="muted">No retro artifact found.</p>`}${improvementsHtml}${retroCandidatesHtml}<h3>Accepted risks</h3>${risksHtml}</section><section id="artifacts"><h2>Artifacts</h2><ul class="artifact-list">${artifacts || `<li>No artifacts found.</li>`}</ul></section><section id="debug-details"><h2>Debug details</h2><details><summary>Usage JSON</summary>${usageHtml}</details><details><summary>Summary Markdown</summary>${report.summaryHtml ?? `<p class="muted">No Markdown summary found.</p>`}</details><details><summary>Raw structured JSON</summary><pre>${escapeHtml(JSON.stringify(report.structuredReport ?? null, null, 2))}</pre></details></section>`, config);
}

function sectionBodyHtml(body: string): string {
	if (!body.trim()) return `<p class="muted">none</p>`;
	return renderMarkdownSafe(body);
}

function structuredSectionsHtml(parsed: ParsedArtifact): string {
	if (!parsed.sections.length) return "";
	return `<div class="section-grid">${parsed.sections.map((section) => `<article class="section-card"><h2>${escapeHtml(section.heading)}</h2>${sectionBodyHtml(section.body)}</article>`).join("")}</div>`;
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

function artifactHtml(config: ReportViewerConfig, viewerReportId: string, artifactPath: string): string {
	const resolved = resolveArtifactPath(config, viewerReportId, artifactPath);
	if (resolved.kind === "external") {
		return page("External artifact", `<p><a href="/reports/${encodeURIComponent(viewerReportId)}">← Report</a></p><p>External artifact: <a href="${escapeHtml(resolved.url)}" rel="noreferrer">${escapeHtml(resolved.url)}</a></p>`, config);
	}
	const text = fs.readFileSync(resolved.path, "utf8");
	const parsed = parseArtifactContract(text, { artifactPath });
	const resultHeader = parsed.result ? `<span class="badge ${badgeClass(parsed.result)}">${escapeHtml(parsed.result)}</span>` : `<span class="badge warn">unparsed</span>`;
	const note = parsed.isContract ? "" : `<div class="panel structured-note"><strong>Structured parsing unavailable for this artifact.</strong><p class="muted">Showing best-effort sections and raw Markdown fallback.</p></div>`;
	const structured = parsed.sections.length ? structuredSectionsHtml(parsed) : renderMarkdownSafe(text);
	return page(path.basename(resolved.path), `<p><a href="/reports/${encodeURIComponent(viewerReportId)}">← Report</a></p><h1>${escapeHtml(path.basename(resolved.path))} ${resultHeader}</h1><p><code>${escapeHtml(resolved.path)}</code></p>${note}${retroCandidateHtml(viewerReportId, artifactPath, parsed.retroCandidates)}${structured}<details><summary>Raw Markdown</summary>${renderMarkdownSafe(text)}</details>`, config);
}

export function createServer(config = loadConfig()): http.Server {
	reconcileStaleRunningRecords(config);
	return http.createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
			const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (request.method === "GET" && url.pathname === "/") return sendHtml(response, indexHtml(config));
			if (request.method === "GET" && url.pathname === "/reports") return sendHtml(response, reportsHtml(config, url.searchParams));
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
