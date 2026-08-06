import * as path from "node:path";
import { DELIVERY_PHASES, type DeliveryPhase } from "../../../shared/delivery-profile-config.ts";
import type { DeliveryReportJsonV2, DeliveryReportStep } from "../../../shared/delivery-report.ts";
import type { ParsedArtifact, RetroCandidate } from "./artifact-contract.ts";
import type { LoadedReport, ProjectMetadataSource, ProjectReportGroup, ReportSummary, ReportViewerConfig, RetroImprovement } from "./server.ts";

export interface DeliveryProfileStateViewModel {
	profiles: string[];
	profileDefinitions: Record<string, Partial<Record<DeliveryPhase, unknown>>>;
	defaultProfile?: string;
	definitionSource: string;
	activeProfile: string;
	activeSource: string;
	envOverride: boolean;
	envProfile?: string;
	savedActiveProfile?: string;
	activeProfilePath: string;
	globalConfigPath: string;
	builtInConfigPath: string;
}

export type DeliveryProfilePanelViewModel =
	| { kind: "available"; state: DeliveryProfileStateViewModel; phases: readonly DeliveryPhase[] }
	| { kind: "unavailable"; message: string };

export interface ReportListQueryViewModel {
	status: string;
	source: string;
	task: string;
	recentDays: string;
}

export interface ReportListPageViewModel {
	title: string;
	query: ReportListQueryViewModel;
	profilePanel: DeliveryProfilePanelViewModel;
	groups: ProjectReportGroup[];
}

type DeliveryReportUsage = NonNullable<DeliveryReportJsonV2["usage"]>;

export interface ReportDetailPageViewModel {
	report: LoadedReport;
	viewerReportId: string;
	title: string;
	fullTask?: string;
	steps: DeliveryReportStep[];
	usage: DeliveryReportJsonV2["usage"] | undefined;
	displayUsage: DeliveryReportUsage["sinceDeliveryStart"] | DeliveryReportUsage["currentSessionTotals"] | undefined;
	acceptedRisks: unknown[];
	pendingIssue: unknown;
	improvements: RetroImprovement[];
	retroArtifact?: { path: string };
	retroCandidates: RetroCandidate[];
}

export type ArtifactPageViewModel =
	| { kind: "external"; viewerReportId: string; artifactPath: string; url: string }
	| { kind: "local"; viewerReportId: string; artifactPath: string; path: string; title: string; text: string; parsed: ParsedArtifact };

function queryValue(query: URLSearchParams, key: string): string {
	return query.get(key) ?? "";
}

export function reportListQueryViewModel(query = new URLSearchParams()): ReportListQueryViewModel {
	return {
		status: queryValue(query, "status"),
		source: queryValue(query, "source"),
		task: queryValue(query, "task"),
		recentDays: queryValue(query, "recentDays"),
	};
}

const TASK_TITLE_MAX_LENGTH = 96;

function trimOuterQuotes(value: string): string {
	let trimmed = value.trim();
	let changed = true;
	while (changed && trimmed.length >= 2) {
		changed = false;
		for (const [opening, closing] of [["\"", "\""], ["'", "'"], ["`", "`"], ["(", ")"], ["[", "]"], ["{", "}"]] as const) {
			if (trimmed.startsWith(opening) && trimmed.endsWith(closing)) {
				trimmed = trimmed.slice(opening.length, -closing.length).trim();
				changed = true;
				break;
			}
		}
	}
	return trimmed;
}

function pathBasename(value: string): string {
	const normalized = value.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).at(-1) || normalized;
}

function isAbsolutePathLike(value: string): boolean {
	return path.isAbsolute(value) || /^~[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function shortenPathToken(token: string): string {
	const leading = /^[\"'`([{<]*/.exec(token)?.[0] ?? "";
	const withoutLeading = token.slice(leading.length);
	const trailing = /[\"'`)}\\]>.,;:!?]+$/.exec(withoutLeading)?.[0] ?? "";
	const core = trailing ? withoutLeading.slice(0, -trailing.length) : withoutLeading;
	if (isAbsolutePathLike(core)) return `${leading}${pathBasename(core)}${trailing}`;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return token;
	const prefixed = /^(.*?)([\"'`([{<]*)(\/|~[\\/]|[A-Za-z]:[\\/])/.exec(token);
	if (!prefixed || (prefixed[1] && !/[=:]$/.test(prefixed[1]) && !prefixed[2])) return token;
	const pathStart = prefixed[1].length + prefixed[2].length;
	const pathWithTrailing = token.slice(pathStart);
	const pathTrailing = /[\"'`)}\\]>.,;:!?]+$/.exec(pathWithTrailing)?.[0] ?? "";
	const pathCore = pathTrailing ? pathWithTrailing.slice(0, -pathTrailing.length) : pathWithTrailing;
	return isAbsolutePathLike(pathCore) ? `${prefixed[1]}${prefixed[2]}${pathBasename(pathCore)}${pathTrailing}` : token;
}

/** Keep quoted and backslash-escaped path spans intact while splitting prose. */
function pathAwareSegments(value: string): string[] {
	const segments: string[] = [];
	let token = "";
	let quote: string | undefined;
	let escaped = false;
	const flushToken = () => {
		if (!token) return;
		segments.push(token);
		token = "";
	};
	const appendWhitespace = (character: string) => {
		const previous = segments.at(-1);
		if (previous && /^\s+$/.test(previous)) segments[segments.length - 1] = `${previous}${character}`;
		else segments.push(character);
	};
	for (const character of value) {
		if (escaped) {
			token += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			token += character;
			escaped = true;
			continue;
		}
		if (quote) {
			token += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if ((character === '"' || character === "'" || character === "`") && (!token || /[=:([{<]$/.test(token))) {
			token += character;
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			flushToken();
			appendWhitespace(character);
			continue;
		}
		token += character;
	}
	flushToken();
	return segments;
}

/** Shortens absolute paths for labels while callers can retain the original as a title/value. */
export function shortenPathForDisplay(value: string): string {
	const raw = String(value ?? "");
	const trimmed = raw.trim();
	if (trimmed && isAbsolutePathLike(trimmed) && !/[\r\n]/.test(trimmed)) {
		const leading = raw.slice(0, raw.indexOf(trimmed));
		const trailingWhitespace = raw.slice(raw.indexOf(trimmed) + trimmed.length);
		const trailingPunctuation = /[\"'`)}\\]>.,;:!?]+$/.exec(trimmed)?.[0] ?? "";
		const core = trailingPunctuation ? trimmed.slice(0, -trailingPunctuation.length) : trimmed;
		return `${leading}${pathBasename(core)}${trailingPunctuation}${trailingWhitespace}`;
	}
	return pathAwareSegments(raw).map((part) => /^\s+$/.test(part) ? part : shortenPathToken(part)).join("");
}

function isBareRelativeFilename(value: string): boolean {
	if (/\s/.test(value) || /[\\/]/.test(value)) return false;
	return /^(?:\.[A-Za-z0-9][A-Za-z0-9._-]*|(?:README|LICENSE|COPYING|AUTHORS|CONTRIBUTING|CHANGELOG|MAKEFILE|DOCKERFILE|GEMFILE|RAKEFILE|PROCFILE|VAGRANTFILE|JUSTFILE|TASKFILE)(?:\.[A-Za-z0-9._-]+)?|[A-Za-z0-9_-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)$/i.test(value);
}

function isPathOrUrlOnly(value: string): boolean {
	const candidate = trimOuterQuotes(value.replace(/^[-*]\s+/, "")).replace(/[),.;:!?]+$/, "").trim();
	if (!candidate || /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)/i.test(candidate)) return true;
	if (isAbsolutePathLike(candidate)) return true;
	return !/\s/.test(candidate) && (/[\\/]/.test(candidate) || isBareRelativeFilename(candidate));
}

function firstMeaningfulTaskSentence(task: string, fallback: string): string {
	const candidates = String(task ?? "")
		.split(/\r?\n/)
		.map((line) => trimOuterQuotes(line.replace(/^[-*]\s+/, "")))
		.filter((line) => line && !isPathOrUrlOnly(line));
	const first = shortenPathForDisplay(candidates.join(" "));
	if (!first) return fallback;
	const sentence = /^(.+?[.!?])(?:\s|$)/.exec(first)?.[1]?.trim();
	return sentence || first;
}

export function compactTaskTitle(task: string, fallback = "Untitled delivery report"): string {
	let title = firstMeaningfulTaskSentence(task, fallback).replace(/\s+/g, " ").trim();
	if (!title) title = fallback;
	if (title.length <= TASK_TITLE_MAX_LENGTH) return title;
	const slice = title.slice(0, TASK_TITLE_MAX_LENGTH - 1);
	const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("/"), slice.lastIndexOf("-"));
	return `${slice.slice(0, boundary > 48 ? boundary : TASK_TITLE_MAX_LENGTH - 1).trim()}…`;
}

export function filterReports(reports: ReportSummary[], query: URLSearchParams): ReportSummary[] {
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

export function buildReportListPageViewModel(args: {
	reports: ReportSummary[];
	query?: URLSearchParams;
	profileState?: DeliveryProfileStateViewModel;
	profileError?: string;
}): ReportListPageViewModel {
	const query = args.query ?? new URLSearchParams();
	return {
		title: "Pi delivery reports",
		query: reportListQueryViewModel(query),
		profilePanel: args.profileError
			? { kind: "unavailable", message: args.profileError }
			: { kind: "available", state: args.profileState!, phases: DELIVERY_PHASES },
		groups: groupReportsByProject(filterReports(args.reports, query)),
	};
}

export function buildReportDetailPageViewModel(args: {
	report: LoadedReport;
	improvements: RetroImprovement[];
	retroArtifact?: { path: string };
	retroCandidates: RetroCandidate[];
}): ReportDetailPageViewModel {
	const steps: DeliveryReportStep[] = Array.isArray(args.report.structuredReport?.steps) ? args.report.structuredReport.steps : [];
	const usage = args.report.structuredReport?.usage;
	const sinceDeliveryStart = usage?.sinceDeliveryStart;
	const currentSessionTotals = usage?.currentSessionTotals;
	const usageReported = usage?.attribution !== "unavailable";
	const displayUsage = usageReported && sinceDeliveryStart && sinceDeliveryStart.assistantMessages > 0 ? sinceDeliveryStart : usageReported && currentSessionTotals && currentSessionTotals.assistantMessages > 0 ? currentSessionTotals : undefined;
	const acceptedRisks = Array.isArray(args.report.structuredReport?.acceptedRisks) ? args.report.structuredReport.acceptedRisks : [];
	const title = compactTaskTitle(args.report.task, args.report.extensionReportId);
	return {
		report: args.report,
		viewerReportId: args.report.viewerReportId,
		title,
		...(title === args.report.task ? {} : { fullTask: args.report.task }),
		steps,
		usage,
		displayUsage,
		acceptedRisks,
		pendingIssue: args.report.structuredReport?.pendingIssue,
		improvements: args.improvements,
		...(args.retroArtifact ? { retroArtifact: args.retroArtifact } : {}),
		retroCandidates: args.retroCandidates,
	};
}

export function buildArtifactPageViewModel(args: {
	viewerReportId: string;
	artifactPath: string;
	resolved: { kind: "external"; url: string } | { kind: "local"; path: string };
	text?: string;
	parsed?: ParsedArtifact;
}): ArtifactPageViewModel {
	if (args.resolved.kind === "external") return { kind: "external", viewerReportId: args.viewerReportId, artifactPath: args.artifactPath, url: args.resolved.url };
	if (args.text === undefined || !args.parsed) throw new Error("Local artifact view-model requires text and parsed artifact data.");
	return { kind: "local", viewerReportId: args.viewerReportId, artifactPath: args.artifactPath, path: args.resolved.path, title: args.resolved.path.split(/[\\/]/).pop() ?? args.resolved.path, text: args.text, parsed: args.parsed };
}
