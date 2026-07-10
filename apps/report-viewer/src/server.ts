import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { activeProfileFilePayload, profileConfigFromRaw, readActiveProfilePayload, selectDeliveryProfile, type DeliveryProfileDefinitionSource, type DeliveryProfileDefinitions, type DeliveryProfileSelectionSource } from "../../../shared/delivery-profile-config.ts";
import type { DeliveryProjectMetadataV1, DeliveryReportJsonV2, DeliveryReportStep } from "../../../shared/delivery-report.ts";
import { renderArtifactPage, renderIndexPage, renderReportPage, renderReportsPage } from "./report-components.ts";
import { escapeHtml, renderMarkdownSafe } from "./markdown-renderer.ts";
export { groupReportsByProject, compactTaskTitle } from "./report-view-model.ts";
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

export type ProjectMetadataSource = "project-json" | "report-json" | "inferred";

export interface ReportSummary {
	viewerReportId: string;
	viewerProjectId: string;
	extensionReportId: string;
	source: ReportSource;
	task: string;
	status: string;
	phase?: string;
	artifactDir: string;
	projectId: string;
	projectName?: string;
	projectRoot?: string;
	gitRoot?: string;
	gitRemote?: string;
	projectMetadataSource: ProjectMetadataSource;
	projectWarnings: string[];
	updatedAt: number;
}

export interface ProjectReportGroup {
	viewerProjectId: string;
	projectId: string;
	projectName: string;
	projectRoot?: string;
	gitRoot?: string;
	gitRemote?: string;
	runCount: number;
	latestUpdatedAt: number;
	reports: ReportSummary[];
	metadataSource: ProjectMetadataSource;
	warnings: string[];
}

export interface LoadedReport extends ReportSummary {
	structuredReport?: DeliveryReportJsonV2;
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
const DELIVERY_EXTENSION_NAME = "delivery-state-machine";

export interface DeliveryProfileState {
	profiles: string[];
	profileDefinitions: DeliveryProfileDefinitions;
	defaultProfile?: string;
	definitionSource: DeliveryProfileDefinitionSource;
	activeProfile: string;
	activeSource: DeliveryProfileSelectionSource;
	envOverride: boolean;
	envProfile?: string;
	savedActiveProfile?: string;
	activeProfilePath: string;
	globalConfigPath: string;
	builtInConfigPath: string;
}

export function expandHome(value: string): string {
	return value
		.replace(/^~(?=$|\/)/, os.homedir())
		.replace(/\$\{home\}/g, os.homedir());
}

function splitEnvList(value: string | undefined): string[] | undefined {
	const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
	return items?.length ? items : undefined;
}

export function deliveryAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ? path.resolve(expandHome(env.PI_CODING_AGENT_DIR)) : path.join(os.homedir(), ".pi", "agent");
}

function deliveryExtensionConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(deliveryAgentDir(env), "extensions", DELIVERY_EXTENSION_NAME);
}

function activeProfilePath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(deliveryExtensionConfigDir(env), "active-profile.json");
}

function globalPhaseLaunchesPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(deliveryExtensionConfigDir(env), "phase-launches.json");
}

function builtInPhaseLaunchesPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "extensions", DELIVERY_EXTENSION_NAME, "phase-launches.json");
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

function readJsonIfPresent<T = unknown>(filePath: string): T | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readDeliveryProfileConfig(env: NodeJS.ProcessEnv = process.env): { defaultProfile?: string; profiles: string[]; profileDefinitions: DeliveryProfileDefinitions; definitionSource: DeliveryProfileState["definitionSource"]; globalConfigPath: string; builtInConfigPath: string } {
	const globalConfigPath = globalPhaseLaunchesPath(env);
	const builtInConfigPath = builtInPhaseLaunchesPath();
	if (fs.existsSync(globalConfigPath)) {
		return { ...profileConfigFromRaw(readJsonIfPresent(globalConfigPath), globalConfigPath), definitionSource: "global-phase-launches", globalConfigPath, builtInConfigPath };
	}
	return { ...profileConfigFromRaw(readJsonIfPresent(builtInConfigPath), builtInConfigPath), definitionSource: "built-in-phase-launches", globalConfigPath, builtInConfigPath };
}

function readSavedActiveProfile(filePath: string): string | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	return readActiveProfilePayload(readJsonIfPresent(filePath), filePath);
}

export function loadDeliveryProfileState(env: NodeJS.ProcessEnv = process.env): DeliveryProfileState {
	const config = readDeliveryProfileConfig(env);
	const activePath = activeProfilePath(env);
	const selection = selectDeliveryProfile({
		profiles: config.profiles,
		defaultProfile: config.defaultProfile,
		definitionSource: config.definitionSource,
		envProfile: env.PI_DELIVERY_PROFILE,
		savedActiveProfile: readSavedActiveProfile(activePath),
	});
	return {
		profiles: config.profiles,
		profileDefinitions: config.profileDefinitions,
		...(config.defaultProfile ? { defaultProfile: config.defaultProfile } : {}),
		definitionSource: config.definitionSource,
		activeProfile: selection.activeProfile,
		activeSource: selection.activeSource,
		envOverride: selection.envOverride,
		...(selection.envProfile ? { envProfile: selection.envProfile } : {}),
		...(selection.savedActiveProfile ? { savedActiveProfile: selection.savedActiveProfile } : {}),
		activeProfilePath: activePath,
		globalConfigPath: config.globalConfigPath,
		builtInConfigPath: config.builtInConfigPath,
	};
}

function writeActiveProfileAtomic(profileName: string, env: NodeJS.ProcessEnv = process.env): string {
	const state = loadDeliveryProfileState(env);
	if (!state.profiles.includes(profileName)) throw new Error(`Delivery profile ${profileName} is not defined in ${state.definitionSource}.`);
	const destination = activeProfilePath(env);
	const expectedDir = deliveryExtensionConfigDir(env);
	const resolvedDestination = path.resolve(destination);
	if (resolvedDestination !== path.join(path.resolve(expectedDir), "active-profile.json")) throw new Error("Invalid active profile destination");
	fs.mkdirSync(expectedDir, { recursive: true });
	const tempPath = path.join(expectedDir, `.active-profile.json.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(activeProfileFilePayload(profileName), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tempPath, resolvedDestination);
	} catch (error) {
		try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch { /* ignore cleanup errors */ }
		throw error;
	}
	return resolvedDestination;
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

interface ProjectMetadata {
	projectId?: string;
	name?: string;
	root?: string;
	gitRoot?: string;
	gitRemote?: string;
	metadataSource: "project-json" | "inferred";
	warnings: string[];
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function makeViewerProjectId(rootIndex: number, projectDirectoryName: string): string {
	return base64UrlEncode(`${rootIndex}:projects/${projectDirectoryName}`);
}

function projectDirectoryNameFromRunDir(root: string, dir: string): string | undefined {
	const parts = path.relative(root, dir).split(path.sep);
	return parts[0] === "projects" && parts[1] && parts[2] === "runs" ? parts[1] : undefined;
}

function readProjectMetadata(projectDir: string): ProjectMetadata {
	const projectDirectoryName = path.basename(projectDir);
	const projectJsonPath = path.join(projectDir, "project.json");
	if (!fs.existsSync(projectJsonPath)) {
		return {
			projectId: projectDirectoryName,
			metadataSource: "inferred",
			warnings: ["Project metadata is incomplete; project.json is missing."],
		};
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("project.json must contain an object");
		const project = parsed as Partial<DeliveryProjectMetadataV1>;
		const projectId = stringField(project.projectId) ?? projectDirectoryName;
		const warnings = stringField(project.projectId) ? [] : ["Project metadata is incomplete; project.json has no projectId."];
		return {
			projectId,
			name: stringField(project.name),
			root: stringField(project.root),
			gitRoot: stringField(project.gitRoot),
			gitRemote: stringField(project.gitRemote),
			metadataSource: "project-json",
			warnings,
		};
	} catch (error) {
		return {
			projectId: projectDirectoryName,
			metadataSource: "inferred",
			warnings: [`Project metadata is incomplete; project.json could not be read: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

function projectMetadataForReportDir(root: string, dir: string): ProjectMetadata | undefined {
	const projectDirectoryName = projectDirectoryNameFromRunDir(root, dir);
	return projectDirectoryName ? readProjectMetadata(path.join(root, "projects", projectDirectoryName)) : undefined;
}

function reportProjectMetadata(structured: DeliveryReportJsonV2 | undefined): ProjectMetadata | undefined {
	const project = structured?.project;
	if (!project || typeof project !== "object" || Array.isArray(project)) return undefined;
	return {
		projectId: stringField(project.projectId),
		name: stringField(project.name),
		root: stringField(project.root),
		gitRoot: stringField(project.gitRoot),
		gitRemote: stringField(project.gitRemote),
		metadataSource: "project-json",
		warnings: [],
	};
}

function resolvedProjectMetadata(rootIndex: number, root: string, dir: string, projectMetadata?: ProjectMetadata, structured?: DeliveryReportJsonV2): Pick<ReportSummary, "viewerProjectId" | "projectId" | "projectName" | "projectRoot" | "gitRoot" | "gitRemote" | "projectMetadataSource" | "projectWarnings"> {
	const projectDirectoryName = projectDirectoryNameFromRunDir(root, dir) ?? "unknown-project";
	const reportProject = reportProjectMetadata(structured);
	const projectJson = projectMetadata?.metadataSource === "project-json" ? projectMetadata : undefined;
	const metadataSource: ProjectMetadataSource = projectJson ? "project-json" : reportProject ? "report-json" : "inferred";
	const projectId = projectJson?.projectId ?? reportProject?.projectId ?? projectMetadata?.projectId ?? projectDirectoryName;
	const projectName = projectJson?.name ?? reportProject?.name;
	const projectRoot = projectJson?.root ?? reportProject?.root;
	const gitRoot = projectJson?.gitRoot ?? reportProject?.gitRoot ?? stringField(structured?.gitRoot);
	const gitRemote = projectJson?.gitRemote ?? reportProject?.gitRemote;
	const warnings = [...(projectMetadata?.warnings ?? [])];
	if (metadataSource !== "project-json" && !warnings.length) warnings.push("Project metadata is incomplete; project.json is missing.");
	return {
		viewerProjectId: makeViewerProjectId(rootIndex, projectDirectoryName),
		projectId,
		...(projectName ? { projectName } : {}),
		...(projectRoot ? { projectRoot } : {}),
		...(gitRoot ? { gitRoot } : {}),
		...(gitRemote ? { gitRemote } : {}),
		projectMetadataSource: metadataSource,
		projectWarnings: warnings,
	};
}

function summaryFromDir(rootIndex: number, root: string, dir: string, projectMetadata?: ProjectMetadata): ReportSummary | undefined {
	const source = reportSourceForDir(dir);
	if (!source) return undefined;
	const relative = path.relative(root, dir) || ".";
	const viewerReportId = makeViewerReportId(rootIndex, relative);
	const fallbackTask = path.basename(dir);
	if (source === "json") {
		const structured = readJsonIfPresent<DeliveryReportJsonV2>(path.join(dir, "delivery-report.json"));
		return {
			viewerReportId,
			...resolvedProjectMetadata(rootIndex, root, dir, projectMetadata, structured),
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
		...resolvedProjectMetadata(rootIndex, root, dir, projectMetadata),
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
		const projectsDir = path.join(root, "projects");
		if (!isDirectory(projectsDir)) return;
		for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
			if (!projectEntry.isDirectory()) continue;
			const projectDir = path.join(projectsDir, projectEntry.name);
			const projectMetadata = readProjectMetadata(projectDir);
			const runsDir = path.join(projectDir, "runs");
			if (!isDirectory(runsDir)) continue;
			for (const runEntry of fs.readdirSync(runsDir, { withFileTypes: true })) {
				if (!runEntry.isDirectory()) continue;
				const dir = path.join(runsDir, runEntry.name);
				const summary = summaryFromDir(rootIndex, root, dir, projectMetadata);
				if (summary) reports.push(summary);
			}
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

export function artifactReferences(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	if (!trimmed) return [];
	const parts = isExternalUrl(trimmed) ? [trimmed] : trimmed.split(/(?:\s+;\s*|\s*;\s+)/);
	const seen = new Set<string>();
	const refs: string[] = [];
	for (const part of parts) {
		const ref = part.trim();
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
	}
	return refs;
}

function artifactListFromStructured(structured: DeliveryReportJsonV2 | undefined): Array<{ label: string; path: string; external: boolean }> {
	const artifacts = new Map<string, { label: string; path: string; external: boolean }>();
	for (const step of Array.isArray(structured?.steps) ? structured.steps : []) {
		const refs = artifactReferences(step?.artifact);
		refs.forEach((ref, index) => {
			const label = refs.length > 1 ? `${stepArtifactLabel(step)} artifact ${index + 1}` : stepArtifactLabel(step);
			if (!artifacts.has(ref)) artifacts.set(ref, { label, path: ref, external: isExternalUrl(ref) });
		});
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
	const summary = summaryFromDir(Number(parseViewerReportId(viewerReportId).rootIndex), root, dir, projectMetadataForReportDir(root, dir));
	if (!summary) throw new Error("Report not found");
	const markdownPath = path.join(dir, "00-delivery-summary.md");
	const summaryMarkdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, "utf8") : undefined;
	const structuredReport = readJsonIfPresent<DeliveryReportJsonV2>(path.join(dir, "delivery-report.json"));
	return {
		...summary,
		structuredReport,
		summaryMarkdown,
		summaryHtml: summaryMarkdown ? renderMarkdownSafe(summaryMarkdown) : undefined,
		artifacts: mergeArtifacts(artifactListFromStructured(structuredReport), conventionalArtifacts(dir)),
	};
}

function isExternalUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value);
}

function isLocalAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) || isWindowsAbsolutePath(value);
}

function normalizeAbsoluteArtifactPath(value: string): string {
	return isWindowsAbsolutePath(value) ? path.win32.normalize(value) : path.resolve(value);
}

function hostAbsoluteArtifactPath(value: string): string {
	return path.isAbsolute(value) ? path.resolve(value) : value;
}

function isBlockedUrlLike(value: string): boolean {
	if (isLocalAbsolutePath(value)) return false;
	try {
		const parsed = new URL(value);
		return parsed.protocol !== "http:" && parsed.protocol !== "https:";
	} catch {
		return /^[a-z][a-z0-9+.-]*:/i.test(value);
	}
}

function isPathInside(candidateRealPath: string, allowedRealPath: string): boolean {
	const relative = path.relative(allowedRealPath, candidateRealPath);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function containsTraversal(rawPath: string): boolean {
	const decoded = decodeURIComponent(rawPath);
	return decoded.split(/[\\/]+/).includes("..");
}

type ArtifactResolution =
	| { kind: "external"; url: string }
	| { kind: "local"; path: string }
	| { kind: "missing"; message: string }
	| { kind: "blocked"; message: string };

function trustedArtifactReferences(reportDir: string): Set<string> {
	const structured = readJsonIfPresent<DeliveryReportJsonV2>(path.join(reportDir, "delivery-report.json"));
	const refs = new Set<string>();
	for (const step of Array.isArray(structured?.steps) ? structured.steps : []) {
		for (const ref of artifactReferences(step.artifact)) refs.add(ref);
	}
	return refs;
}

function artifactResolution(
	config: Pick<ReportViewerConfig, "reportRoots">,
	viewerReportId: string,
	artifactPath: string,
): ArtifactResolution {
	if (isExternalUrl(artifactPath)) return { kind: "external", url: artifactPath };
	if (isBlockedUrlLike(artifactPath)) return { kind: "blocked", message: "Unsupported artifact URL scheme" };
	if (containsTraversal(artifactPath)) return { kind: "blocked", message: "Artifact path traversal is not allowed" };
	const { dir } = reportDirForId(config, viewerReportId);
	const allowedRoots = [dir, ...config.reportRoots.map((root) => fs.realpathSync(path.resolve(expandHome(root))))];
	const isAbsoluteArtifact = isLocalAbsolutePath(artifactPath);
	const candidate = isAbsoluteArtifact ? hostAbsoluteArtifactPath(artifactPath) : path.resolve(dir, artifactPath);
	if (isAbsoluteArtifact) {
		const requestedRef = normalizeAbsoluteArtifactPath(artifactPath);
		const trustedAbsoluteRefs = [...trustedArtifactReferences(dir)]
			.filter(isLocalAbsolutePath)
			.map(normalizeAbsoluteArtifactPath);
		if (!trustedAbsoluteRefs.includes(requestedRef)) return { kind: "blocked", message: "Absolute artifact path is not referenced by this report" };
		if (!fs.existsSync(candidate)) return { kind: "missing", message: "Artifact not found" };
		const lstat = fs.lstatSync(candidate);
		if (lstat.isSymbolicLink()) return { kind: "blocked", message: "Absolute artifact symlinks are not allowed" };
		if (!fs.statSync(candidate).isFile()) return { kind: "blocked", message: "Artifact is not a file" };
		return { kind: "local", path: candidate };
	}
	if (!fs.existsSync(candidate)) return { kind: "missing", message: "Artifact not found" };
	const realCandidate = fs.realpathSync(candidate);
	if (!allowedRoots.some((allowedRoot) => isPathInside(realCandidate, allowedRoot))) {
		return { kind: "blocked", message: "Artifact path escapes configured report roots" };
	}
	if (!fs.statSync(realCandidate).isFile()) return { kind: "blocked", message: "Artifact is not a file" };
	return { kind: "local", path: realCandidate };
}

export function resolveArtifactPath(
	config: Pick<ReportViewerConfig, "reportRoots">,
	viewerReportId: string,
	artifactPath: string,
): { kind: "external"; url: string } | { kind: "local"; path: string } {
	const resolved = artifactResolution(config, viewerReportId, artifactPath);
	if (resolved.kind === "external" || resolved.kind === "local") return resolved;
	throw new Error(resolved.message);
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

function reportPageDataSource() {
	return {
		scanReports,
		loadDeliveryProfileState,
		loadReport,
		listImprovements,
		readJsonIfPresent,
		readJsonArray,
		improvementsPath,
		runsPath,
		artifactReferences,
		artifactResolution,
		resolveArtifactPath,
	};
}

export function createServer(config = loadConfig()): http.Server {
	reconcileStaleRunningRecords(config);
	return http.createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
			const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (request.method === "GET" && url.pathname === "/") return sendHtml(response, renderIndexPage(config, reportPageDataSource()));
			if (request.method === "GET" && url.pathname === "/reports") return sendHtml(response, renderReportsPage(config, url.searchParams, reportPageDataSource()));
			if (segments[0] === "api" && segments[1] === "delivery-profiles" && segments[2] === "global") {
				if (request.method === "GET" && segments.length === 3) return sendJson(response, 200, loadDeliveryProfileState());
				if (request.method === "POST" && segments[3] === "active") {
					requireCsrfToken(request, config);
					const body = await readRequestJson(request);
					if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.activeProfile !== "string" || !body.activeProfile.trim()) {
						throw new Error("Request body must include activeProfile string.");
					}
					writeActiveProfileAtomic(body.activeProfile.trim());
					return sendJson(response, 200, loadDeliveryProfileState());
				}
			}
			if (segments[0] === "reports" && segments[1]) {
				const reportId = segments[1];
				if (request.method === "GET" && segments.length === 2) return sendHtml(response, renderReportPage(config, reportId, reportPageDataSource()));
				if (request.method === "GET" && segments[2] === "artifacts") return sendHtml(response, renderArtifactPage(config, reportId, segments.slice(3).join("/"), reportPageDataSource()));
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
