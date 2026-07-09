import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { DELIVERY_PHASES, activeProfileFilePayload, profileConfigFromRaw, readActiveProfilePayload, selectDeliveryProfile, type DeliveryProfileDefinitionSource, type DeliveryProfileDefinitions, type DeliveryProfileSelectionSource } from "../../../shared/delivery-profile-config.ts";
import type { DeliveryProjectMetadataV1, DeliveryReportJsonV2 } from "../../../shared/delivery-report.ts";
import type { UsageTotals } from "../../../shared/session-usage.ts";
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

interface DeliveryProfileState {
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
		for (const ref of artifactReferences((step as any)?.artifact)) refs.add(ref);
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

function projectNameForGroup(report: ReportSummary): string {
	if (report.projectName) return report.projectName;
	if (report.projectId.startsWith("unknown-")) return "Unknown project";
	return report.projectId || "Unknown project";
}

function addWarning(warnings: Set<string>, warning: string | undefined) {
	if (warning?.trim()) warnings.add(warning.trim());
}

export function groupReportsByProject(reports: ReportSummary[]): ProjectReportGroup[] {
	const groups = new Map<string, ProjectReportGroup & { warningSet: Set<string> }>();
	const sourceRank: Record<ProjectMetadataSource, number> = { "project-json": 3, "report-json": 2, inferred: 1 };
	for (const report of reports) {
		const key = report.viewerProjectId;
		let group = groups.get(key);
		if (!group) {
			const warningSet = new Set<string>();
			for (const warning of report.projectWarnings) addWarning(warningSet, warning);
			if (report.projectId.startsWith("unknown-") && !report.projectName) addWarning(warningSet, "Metadata incomplete; likely migrated from a legacy flat report.");
			group = {
				viewerProjectId: report.viewerProjectId,
				projectId: report.projectId,
				projectName: projectNameForGroup(report),
				...(report.projectRoot ? { projectRoot: report.projectRoot } : {}),
				...(report.gitRoot ? { gitRoot: report.gitRoot } : {}),
				...(report.gitRemote ? { gitRemote: report.gitRemote } : {}),
				runCount: 0,
				latestUpdatedAt: 0,
				reports: [],
				metadataSource: report.projectMetadataSource,
				warnings: [],
				warningSet,
			};
			groups.set(key, group);
		} else {
			for (const warning of report.projectWarnings) addWarning(group.warningSet, warning);
			if (sourceRank[report.projectMetadataSource] > sourceRank[group.metadataSource]) group.metadataSource = report.projectMetadataSource;
			if (!group.projectName || group.projectName === group.projectId || group.projectName === "Unknown project") group.projectName = projectNameForGroup(report);
			if (!group.projectRoot && report.projectRoot) group.projectRoot = report.projectRoot;
			if (!group.gitRoot && report.gitRoot) group.gitRoot = report.gitRoot;
			if (!group.gitRemote && report.gitRemote) group.gitRemote = report.gitRemote;
		}
		group.runCount += 1;
		group.latestUpdatedAt = Math.max(group.latestUpdatedAt, report.updatedAt);
		group.reports.push(report);
	}
	return [...groups.values()]
		.map(({ warningSet, ...group }) => ({
			...group,
			reports: group.reports.sort((a, b) => b.updatedAt - a.updatedAt || a.viewerReportId.localeCompare(b.viewerReportId)),
			warnings: [...warningSet],
		}))
		.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt || a.projectName.localeCompare(b.projectName));
}

interface ReportListSignal {
	label: string;
	badge: "ok" | "warn" | "bad" | "";
}

function stepPhase(step: any): string {
	return String(step?.phase ?? "").toUpperCase();
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

function stepVerdict(step: any, config?: Pick<ReportViewerConfig, "reportRoots">, viewerReportId?: string): string {
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
	const structured = report.source === "json" ? readJsonIfPresent(path.join(report.artifactDir, "delivery-report.json")) : undefined;
	const steps = Array.isArray(structured?.steps) ? structured.steps : [];
	const failedQualitySteps = steps.filter((step: any) => ["VERIFY", "REVIEW"].includes(stepPhase(step)) && stepVerdict(step, config, report.viewerReportId).toUpperCase().includes("FAIL"));
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

function selectedProfileSetupHtml(state: DeliveryProfileState): string {
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

function deliveryProfilePanelHtml(): string {
	try {
		const state = loadDeliveryProfileState();
		const options = state.profiles.map((profile) => `<option value="${escapeHtml(profile)}" ${profile === state.activeProfile ? "selected" : ""}>${escapeHtml(profile)}</option>`).join("");
		const override = state.envOverride ? `<p><span class="badge warn">Environment override active</span> <span class="muted"><code>PI_DELIVERY_PROFILE=${escapeHtml(state.envProfile ?? "")}</code> is effective; saving here changes the global default for future runs without that env override.</span></p>` : "";
		return `<section class="panel" id="delivery-profile"><h2>Delivery model profile</h2><p>Active global profile: <span class="badge">${escapeHtml(state.activeProfile)}</span></p>${override}<form class="filters" id="delivery-profile-form"><label>Profile <select name="activeProfile">${options}</select></label><button type="submit">Switch global profile</button></form>${selectedProfileSetupHtml(state)}<p class="muted">Profiles are read from ${escapeHtml(state.definitionSource === "global-phase-launches" ? "global config" : "built-in defaults")}. This writes only <code>active-profile.json</code> under the pi agent directory; project files are never edited.</p><div class="muted" id="delivery-profile-message"></div><script>document.getElementById('delivery-profile-form')?.addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const message=document.getElementById('delivery-profile-message');const token=document.querySelector('meta[name="report-viewer-csrf-token"]').content;const activeProfile=form.elements.activeProfile.value;message.textContent='Saving…';const response=await fetch('/api/delivery-profiles/global/active',{method:'POST',headers:{'content-type':'application/json','x-report-viewer-token':token},body:JSON.stringify({activeProfile})});if(response.ok){const body=await response.json();message.textContent='Saved global profile: '+body.savedActiveProfile+(body.envOverride?' (environment override is still effective)':'');}else{const body=await response.json().catch(()=>({error:'Save failed'}));message.textContent='Save failed: '+body.error;}});</script></section>`;
	} catch (error) {
		return `<section class="panel" id="delivery-profile"><h2>Delivery model profile</h2><p><span class="badge bad">Unavailable</span></p><p class="muted">${escapeHtml(error instanceof Error ? error.message : String(error))}</p></section>`;
	}
}

export function compactTaskTitle(task: string, fallback = "Untitled delivery report"): string {
	let title = String(task ?? "").replace(/\s+/g, " ").trim();
	if ((title.startsWith('"') && title.endsWith('"')) || (title.startsWith("`") && title.endsWith("`"))) {
		title = title.slice(1, -1).trim();
	}
	if (!title) title = fallback;
	const maxLength = 96;
	if (title.length <= maxLength) return title;
	const slice = title.slice(0, maxLength - 1);
	const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("/"), slice.lastIndexOf("-"));
	return `${slice.slice(0, boundary > 48 ? boundary : maxLength - 1).trim()}…`;
}

function latestStepForPhase(steps: any[], phase: string): any | undefined {
	return [...steps].reverse().find((step) => stepPhase(step) === phase);
}

function reportBrief(config: Pick<ReportViewerConfig, "reportRoots">, report: ReportSummary): string {
	const structured = report.source === "json" ? readJsonIfPresent<DeliveryReportJsonV2>(path.join(report.artifactDir, "delivery-report.json")) : undefined;
	const steps = Array.isArray(structured?.steps) ? structured.steps : [];
	if (!steps.length) return report.source === "legacy-markdown" ? "Legacy Markdown report; open details for the summary." : "No structured phase steps recorded.";
	const failed = steps.filter((step: any) => ["VERIFY", "REVIEW"].includes(stepPhase(step)) && stepVerdict(step, config, report.viewerReportId).toUpperCase().includes("FAIL"));
	if (failed.length) return `Needs attention: ${failed.map((step: any) => `${stepPhase(step)} #${String(step.attempt ?? "?")}`).join(", ")} reported failure.`;
	const latestReview = latestStepForPhase(steps, "REVIEW");
	const latestVerify = latestStepForPhase(steps, "VERIFY");
	const latestImplement = latestStepForPhase(steps, "IMPLEMENT");
	const main = latestReview ?? latestVerify ?? latestImplement ?? steps.at(-1);
	const phase = stepPhase(main) || "STEP";
	const verdict = stepVerdict(main, config, report.viewerReportId);
	const attempts = steps.filter((step: any) => stepPhase(step) === phase).length;
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

function reportsHtml(config: ReportViewerConfig, query = new URLSearchParams()): string {
	const reports = filterReports(scanReports(config), query);
	const source = query.get("source") ?? "";
	const filterForm = `<form class="panel filters" method="get" action="/reports"><label>Status <input name="status" value="${escapeHtml(query.get("status") ?? "")}" placeholder="DONE, FAIL, REVIEW"></label><label>Source <select name="source"><option value="">Any</option><option value="json" ${source === "json" ? "selected" : ""}>JSON</option><option value="legacy-markdown" ${source === "legacy-markdown" ? "selected" : ""}>Legacy Markdown</option></select></label><label>Task search <input name="task" value="${escapeHtml(query.get("task") ?? "")}" placeholder="task text"></label><label>Recent days <input name="recentDays" type="number" min="1" value="${escapeHtml(query.get("recentDays") ?? "")}"></label><button type="submit">Apply filters</button><a class="button secondary" href="/reports">Reset</a></form>`;
	const groups = groupReportsByProject(reports).map((group) => projectGroupHtml(config, group)).join("");
	return page("Pi delivery reports", `<h1>Pi delivery reports</h1><p class="muted">Find reports by status, source, recency, or task text. Reports are grouped by project and shown as compact rows for easier scanning.</p>${deliveryProfilePanelHtml()}${filterForm}<div class="project-groups">${groups || `<div class="panel">No reports found.</div>`}</div>`, config);
}

function formatUsageNumber(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "unavailable";
}

function formatUsageCost(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "unavailable";
}

function usageTotalsForReport(report: DeliveryReportJsonV2 | undefined): UsageTotals | undefined {
	const sinceDeliveryStart = report?.usage?.sinceDeliveryStart;
	if (sinceDeliveryStart && sinceDeliveryStart.assistantMessages > 0) return sinceDeliveryStart;
	const currentSessionTotals = report?.usage?.currentSessionTotals;
	if (currentSessionTotals && currentSessionTotals.assistantMessages > 0) return currentSessionTotals;
	return undefined;
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

function formatUsageMetric(value: number, metric: UsageBreakdownMetric): string {
	return metric === "cost" ? formatUsageCost(value) : formatUsageNumber(value);
}

function usageBreakdownRows(steps: any[]): UsageBreakdownRow[] {
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

function usageBreakdownHtml(steps: any[]): string {
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

function phaseTokenUsage(step: any): string {
	return formatUsageNumber(step?.usageDelta?.totalTokens);
}

function phaseTokenDetail(step: any): string {
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

function stepDisplaySummary(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, step: any): string {
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

function phaseDisplaySummaries(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: any[]): PhaseDisplaySummary[] {
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

function phaseSummariesHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: any[]): string {
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

function phaseTimelineHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: any[]): string {
	if (!steps.length) return `<p class="muted">No structured timeline is available.</p>`;
	return `<ol class="phase-timeline" aria-label="Compact phase timeline">${steps.map((step) => {
		const verdict = stepVerdict(step, config, viewerReportId);
		const summary = stepDisplaySummary(config, viewerReportId, step);
		return `<li><div class="timeline-label"><strong>${escapeHtml(stepArtifactLabel(step))}</strong><span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span></div><div class="timeline-summary muted">${summary ? escapeHtml(summary) : "No summary"}</div></li>`;
	}).join("")}</ol>`;
}

function outcomeSummaryHtml(config: Pick<ReportViewerConfig, "reportRoots">, report: LoadedReport, steps: any[]): string {
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

function attentionFollowUpsHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, acceptedRisks: unknown[], pendingIssue: unknown, improvements: RetroImprovement[], retroArtifact: { path: string } | undefined, retroCandidates: RetroCandidate[], steps: any[]): string {
	const risksHtml = acceptedRisks.length ? `<ul>${acceptedRisks.map((risk: unknown) => `<li>${escapeHtml(String(risk))}</li>`).join("")}</ul>` : `<p class="muted">No accepted risks recorded.</p>`;
	const improvementsHtml = improvements.length ? `<ul>${improvements.map((item) => `<li><strong>${escapeHtml(item.title)}</strong> <span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span><div class="muted">${escapeHtml(item.description)}</div></li>`).join("")}</ul>` : `<p class="muted">No app-owned retro improvements saved yet.</p>`;
	const retroCandidatesHtml = retroArtifact && retroCandidates.length ? retroCandidateHtml(viewerReportId, retroArtifact.path, retroCandidates) : `<p class="muted">No unsaved retro candidate rows found.</p>`;
	const retroLink = retroArtifact ? `<p>${artifactLinkHtml(config, viewerReportId, retroArtifact.path, "Open retro artifact")}</p>` : `<p class="muted">No retro artifact found.</p>`;
	return `<section id="attention-follow-ups" class="panel"><h2>Attention and follow-ups</h2><div class="attention-grid"><div class="attention-card"><h3>Failures and repairs</h3>${failureRepairHtml(config, viewerReportId, steps)}</div><div class="attention-card"><h3>Pending issue</h3>${pendingIssueSummaryHtml(config, viewerReportId, pendingIssue)}</div><div class="attention-card"><h3>Retro / follow-ups</h3>${retroLink}${improvementsHtml}</div><div class="attention-card"><h3>Accepted risks</h3>${risksHtml}</div></div>${retroCandidatesHtml}</section>`;
}

function phaseStepCardHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, step: any): string {
	const verdict = stepVerdict(step, config, viewerReportId);
	const summary = stepDisplaySummary(config, viewerReportId, step);
	return `<article class="phase-card"><div><strong>${escapeHtml(stepArtifactLabel(step))}</strong> <span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span></div><div class="muted">Agent: ${escapeHtml(String(step.agent ?? "default"))}</div><div class="summary">${summary ? escapeHtml(summary) : `<span class="muted">No summary recorded.</span>`}</div><div class="muted">Tokens: ${escapeHtml(phaseTokenUsage(step))}</div><div class="muted">${escapeHtml(phaseTokenDetail(step))}</div>${artifactLinksHtml(config, viewerReportId, step?.artifact)}</article>`;
}

function phaseJourneyHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: any[]): string {
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
		return `<section class="section-card phase-group"><h3>${escapeHtml(phase)} attempts (${phaseSteps.length})</h3>${repairNote}<div class="phase-grid">${phaseSteps.map((step) => phaseStepCardHtml(config, viewerReportId, step)).join("")}</div></section>`;
	}).join("");
	return `${phaseTimelineHtml(config, viewerReportId, steps)}<details><summary>Phase attempt details</summary><div class="phase-groups">${groups}</div></details>`;
}

function failureRepairHtml(config: Pick<ReportViewerConfig, "reportRoots">, viewerReportId: string, steps: any[]): string {
	const failures = steps.filter((step) => stepVerdict(step, config, viewerReportId).includes("FAIL") || String(step.summary ?? "").toLowerCase().includes("repair"));
	if (!failures.length) return `<p class="muted">No failed verification/review or repair loop is recorded.</p>`;
	return `<ul>${failures.map((step) => {
		const verdict = stepVerdict(step, config, viewerReportId);
		const summary = stepDisplaySummary(config, viewerReportId, step);
		return `<li><strong>${escapeHtml(stepArtifactLabel(step))}</strong>: <span class="badge ${badgeClass(verdict)}">${escapeHtml(verdict)}</span> ${escapeHtml(summary)}</li>`;
	}).join("")}</ul>`;
}

function reportHtml(config: ReportViewerConfig, viewerReportId: string): string {
	const report = loadReport(config, viewerReportId);
	const artifacts = report.artifacts.map((artifact) => `<li>${artifactLinkHtml(config, viewerReportId, artifact.path, artifact.label)}<div><code>${escapeHtml(artifact.path)}</code></div></li>`).join("");
	const steps = Array.isArray(report.structuredReport?.steps) ? report.structuredReport.steps : [];
	const usage = report.structuredReport?.usage;
	const displayUsage = usageTotalsForReport(report.structuredReport);
	const acceptedRisks = Array.isArray(report.structuredReport?.acceptedRisks) ? report.structuredReport.acceptedRisks : [];
	const pendingIssue = report.structuredReport?.pendingIssue;
	const improvements = listImprovements(config, viewerReportId);
	const retroArtifact = report.artifacts.find((artifact) => !artifact.external && /05-retro\.md$/.test(artifact.path) && artifactResolution(config, viewerReportId, artifact.path).kind === "local");
	const retroCandidates = retroArtifact ? unsavedRetroCandidates(report.artifactDir, improvements, retroArtifact.path) : [];
	const sourceNote = report.source === "json"
		? `<p><span class="badge ok">Structured JSON source</span> <span class="muted">Rendered from <code>delivery-report.json</code>; raw JSON stays collapsed below.</span></p>`
		: `<div class="panel"><span class="badge warn">Legacy Markdown source</span><p class="muted">This run does not have <code>delivery-report.json</code>, so only limited metadata is available.</p></div>`;
	const cards = `<section id="overview"><h2>Overview</h2><div class="grid"><div class="card"><div class="label">Status</div><div class="value"><span class="badge ${badgeClass(report.status)}">${escapeHtml(report.status)}</span></div></div><div class="card"><div class="label">Phase</div><div class="value">${escapeHtml(report.phase ?? "—")}</div></div><div class="card"><div class="label">Source</div><div class="value">${escapeHtml(report.source === "json" ? "JSON" : "Markdown")}</div></div><div class="card"><div class="label">Updated</div><div class="value">${escapeHtml(new Date(report.updatedAt).toLocaleString())}</div></div></div><div class="panel"><div class="label">Artifact directory</div><code>${escapeHtml(report.artifactDir)}</code></div></section>`;
	const usageHtml = usage ? `<pre>${escapeHtml(JSON.stringify(usage, null, 2))}</pre>` : `<p class="muted">No structured usage data.</p>`;
	const pendingRawHtml = pendingIssue ? `<pre>${escapeHtml(JSON.stringify(pendingIssue, null, 2))}</pre>` : `<p class="muted">No pending issue.</p>`;
	const title = compactTaskTitle(report.task, report.extensionReportId);
	const fullTaskDetails = title === report.task ? "" : `<details class="full-task"><summary>Full delivery task</summary><p>${escapeHtml(report.task)}</p></details>`;
	const structuredDisplay = `<section id="phase-summaries"><h2>Phase summaries</h2>${phaseSummariesHtml(config, viewerReportId, steps)}</section><section id="phase-journey"><h2>Compact phase timeline</h2>${phaseJourneyHtml(config, viewerReportId, steps)}</section>`;
	return page(report.task, `<p><a href="/reports">← Reports</a></p><h1 title="${escapeHtml(report.task)}">${escapeHtml(title)}</h1>${fullTaskDetails}${sourceNote}${outcomeSummaryHtml(config, report, steps)}${cards}${usageCardsHtml(displayUsage)}${usageBreakdownHtml(steps)}${structuredDisplay}${attentionFollowUpsHtml(config, viewerReportId, acceptedRisks, pendingIssue, improvements, retroArtifact, retroCandidates, steps)}<section id="artifacts"><h2>Artifacts</h2><ul class="artifact-list">${artifacts || `<li>No artifacts found.</li>`}</ul></section><section id="debug-details"><h2>Debug details</h2><details><summary>Usage JSON</summary>${usageHtml}</details><details><summary>Pending issue JSON</summary>${pendingRawHtml}</details><details><summary>Summary Markdown</summary>${report.summaryHtml ?? `<p class="muted">No Markdown summary found.</p>`}</details><details><summary>Raw structured JSON</summary><pre>${escapeHtml(JSON.stringify(report.structuredReport ?? null, null, 2))}</pre></details></section>`, config);
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
