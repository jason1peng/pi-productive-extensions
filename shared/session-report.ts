import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addUsageTotals,
	emptyUsageTotals,
	subagentSessionDirFor,
	type UsageTotals,
	usageTotalsFromRawUsage,
} from "./session-usage.ts";

export const SESSION_REPORT_SCHEMA_VERSION = 1 as const;
export const SESSION_REPORT_TYPE = "session-report" as const;
export const SESSION_REPORT_JSON_NAME = "session-report.json" as const;
export const SESSION_REPORT_MARKDOWN_NAME = "session-report.md" as const;

export type SessionReportStatus = "ok" | "partial" | "unavailable";
export type SessionSourceStatus = "available" | "missing" | "unreadable" | "ephemeral";

export interface SessionReportUsage {
	status: "complete" | "partial" | "unknown";
	parent: UsageTotals | null;
	subagents: UsageTotals | null;
	total: UsageTotals | null;
}

export interface ToolMetric {
	requested: number;
	persistedResults: number;
	failedResults: number;
	missingResults: number;
	unmatchedResults: number;
	duplicateResults: number;
}

export interface ToolActivity extends ToolMetric {
	byTool: Record<string, ToolMetric>;
}

export interface SkillMetric {
	count: number;
	names: string[];
	byName: Record<string, number>;
}

export interface SkillActivity {
	explicitInvocations: SkillMetric;
	skillFileReads: SkillMetric;
}

export interface SessionNodeReport {
	kind: "parent" | "child";
	status: SessionSourceStatus;
	sessionId: string | null;
	runId: string | null;
	runIndex: string | null;
	agent: string | null;
	records: number | null;
	malformedLines: number | null;
	requestedToolCalls: number | null;
	persistedToolResults: number | null;
	failedToolResults: number | null;
	compactionCount: number | null;
	truncatedCount: number | null;
	branchPointCount: number | null;
	hasSessionHeader: boolean | null;
}

export interface SessionTopology {
	parent: SessionNodeReport;
	children: SessionNodeReport[];
	sessionCount: number;
	availableSessionCount: number;
	missingSessionCount: number;
	ephemeralSessionCount: number;
	unreadableSessionCount: number;
	compactedSessionCount: number;
	branchedSessionCount: number;
	branchPointCount: number;
}

export interface SessionReportEvidence {
	source: "persisted-session-jsonl";
	readableFileCount: number;
	unavailableFileCount: number;
	malformedLineCount: number;
	compactionCount: number;
	truncatedCount: number;
	branchPointCount: number;
	usageIncludesPersistedRecordsOnly: true;
	promptsRedacted: true;
	argumentsRedacted: true;
	rawMessagesRedacted: true;
	secretsRedacted: true;
	gitLabScanned: false;
	mrDataIncluded: false;
}

/**
 * Versioned local evidence contract. The report deliberately contains no
 * filesystem paths, prompts, tool arguments, raw messages, or MR fields.
 */
export interface SessionReport {
	schemaVersion: typeof SESSION_REPORT_SCHEMA_VERSION;
	reportType: typeof SESSION_REPORT_TYPE;
	status: SessionReportStatus;
	usage: SessionReportUsage;
	topology: SessionTopology;
	tools: ToolActivity | null;
	skills: SkillActivity | null;
	evidence: SessionReportEvidence;
}

export interface SessionReportArtifactPaths {
	jsonPath: string;
	markdownPath: string;
}

export interface SessionReportArtifactOptions {
	directory?: string;
}

interface JsonObject {
	[key: string]: unknown;
}

interface ParsedSession {
	file: string;
	status: "available" | "missing" | "unreadable";
	records: JsonObject[];
	malformedLines: number;
	truncatedCount: number;
	lineCount: number;
}

interface ChildSource {
	file?: string;
	status: "available" | "missing" | "ephemeral" | "unreadable";
	runId?: string;
	runIndex?: string;
	agent?: string;
}

interface ToolRequest {
	id: string;
	toolName: string;
	arguments?: unknown;
	source: "message" | "start";
}

interface ToolResult {
	id: string;
	toolName: string;
	failed: boolean;
	source: "message" | "end";
	/** Parent tool-result details can identify the delegated run being reported. */
	runId?: string;
}

interface SessionFacts {
	parsed?: ParsedSession;
	node: SessionNodeReport;
	usage: UsageTotals | null;
	requests: ToolRequest[];
	results: ToolResult[];
	skills: SkillActivity | null;
	compactionCount: number;
	truncatedCount: number;
	branchPointCount: number;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeLabel(value: unknown, fallback = "unknown", maxLength = 80): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	const normalized = value.trim().replace(/[^A-Za-z0-9._:@/-]+/g, "_").slice(0, maxLength);
	if (/password|secret|token|credential|api[_-]?key|bearer|private[_-]?key/i.test(normalized)) return "redacted";
	// Labels become JSON object keys in the aggregate counters. Do not allow
	// persisted input to address Object.prototype or mutate the report shape.
	if (normalized === "__proto__" || Object.prototype.hasOwnProperty.call(Object.prototype, normalized)) return fallback;
	return normalized || fallback;
}

function safeIdentifier(value: unknown): string | null {
	const result = stringValue(value);
	if (!result) return null;
	const leaf = result.split(/[\\/]/).filter(Boolean).pop() ?? result;
	return safeLabel(leaf.replace(/:/g, "_"), "unknown", 120);
}

function nestedMessage(record: JsonObject): JsonObject | undefined {
	return isObject(record.message) ? record.message : undefined;
}

function recordRole(record: JsonObject): string | undefined {
	return stringValue(record.role) ?? stringValue(nestedMessage(record)?.role);
}

function recordType(record: JsonObject): string | undefined {
	return stringValue(record.recordType) ?? stringValue(record.type);
}

function isTruncatedRecord(record: JsonObject): boolean {
	return recordType(record)?.toLowerCase() === "truncated";
}

function parseJsonlContent(content: string, file: string): ParsedSession {
	const records: JsonObject[] = [];
	let malformedLines = 0;
	let truncatedCount = 0;
	let lineCount = 0;
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		lineCount++;
		try {
			const value: unknown = JSON.parse(line);
			if (isObject(value)) {
				records.push(value);
				if (isTruncatedRecord(value)) truncatedCount++;
			} else malformedLines++;
		} catch {
			malformedLines++;
		}
	}
	return { file, status: "available", records, malformedLines, truncatedCount, lineCount };
}

function readSession(file: string): ParsedSession {
	try {
		return parseJsonlContent(fs.readFileSync(file, "utf8"), file);
	} catch (error) {
		const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;
		return { file, status: code === "ENOENT" ? "missing" : "unreadable", records: [], malformedLines: 0, truncatedCount: 0, lineCount: 0 };
	}
}

function usageForRecord(record: JsonObject): UsageTotals | undefined {
	const message = nestedMessage(record);
	const role = recordRole(record);
	const recordKind = recordType(record);
	const nestedUsage = isObject(message?.usage) ? message.usage : undefined;
	const topLevelUsage = isObject(record.usage) ? record.usage : undefined;

	// Pi's persisted session format is usually type=message with a nested
	// assistant message. Preserve support for records that normalize usage at
	// the top level while retaining the nested session contract.
	if (role === "assistant" && topLevelUsage && record.sourceEventType === "message_end") {
		return usageTotalsFromRawUsage(topLevelUsage);
	}
	if (role === "assistant" && nestedUsage) return usageTotalsFromRawUsage(nestedUsage);
	if (role === "assistant" && topLevelUsage && recordKind === "message") {
		return usageTotalsFromRawUsage(topLevelUsage);
	}
	return undefined;
}

function usageForParsedSession(parsed: ParsedSession): UsageTotals {
	const totals = emptyUsageTotals();
	totals.sessionFiles = 1;
	for (const record of parsed.records) {
		const usage = usageForRecord(record);
		if (usage) addUsageTotals(totals, usage);
	}
	return totals;
}

function contentItems(record: JsonObject): unknown[] {
	const message = nestedMessage(record);
	const content = message?.content ?? record.content;
	return Array.isArray(content) ? content : [];
}

function toolCallId(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : "";
}

function toolName(value: unknown): string {
	if (typeof value === "string") {
		const leaf = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
		return safeLabel(leaf, "unknown-tool");
	}
	return safeLabel(value, "unknown-tool");
}

function parseArgumentsPayload(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function toolCallArguments(item: JsonObject): unknown {
	return parseArgumentsPayload(item.arguments ?? item.input ?? item.params ?? item.argsPayload ?? item.args);
}

function extractToolRequests(records: JsonObject[]): ToolRequest[] {
	const assistantRequests: ToolRequest[] = [];
	const lifecycleRequests: Array<ToolRequest & { explicitId: boolean }> = [];
	let ordinal = 0;
	for (const record of records) {
		const role = recordRole(record)?.toLowerCase();
		const kind = recordType(record)?.toLowerCase();
		const sourceEventType = stringValue(record.sourceEventType)?.toLowerCase();
		if (role === "assistant") {
			for (const item of contentItems(record)) {
				const itemType = isObject(item) && typeof item.type === "string" ? item.type.toLowerCase() : "";
				if (!isObject(item) || (itemType !== "toolcall" && itemType !== "tool_call")) continue;
				const rawId = toolCallId(item.id ?? item.toolCallId);
				assistantRequests.push({
					id: rawId || `anonymous-${ordinal}`,
					toolName: toolName(item.name ?? item.toolName),
					arguments: toolCallArguments(item),
					source: "message",
				});
				ordinal++;
			}
		}
		if (kind === "tool_start" || kind === "tool_call" || kind === "toolcall" || kind === "tool_execution_start" || sourceEventType === "tool_execution_start") {
			const rawId = toolCallId(record.toolCallId ?? record.id);
			lifecycleRequests.push({
				id: rawId,
				explicitId: Boolean(rawId),
				toolName: toolName(record.toolName ?? record.name),
				arguments: parseArgumentsPayload(record.arguments ?? record.input ?? record.argsPayload ?? record.args),
				source: "start",
			});
		}
	}

	const requests = [...assistantRequests];
	const matchedAssistant = new Set<ToolRequest>();
	const matchAssistant = (predicate: (request: ToolRequest) => boolean): ToolRequest | undefined => {
		const match = assistantRequests.find((request) => !matchedAssistant.has(request) && predicate(request));
		if (match) matchedAssistant.add(match);
		return match;
	};
	let lifecycleOrdinal = 0;
	for (const lifecycle of lifecycleRequests) {
		const existing = lifecycle.explicitId
			? matchAssistant((request) => request.id === lifecycle.id)
			: matchAssistant((request) => request.toolName === lifecycle.toolName);
		if (existing) {
			if (existing.arguments === undefined && lifecycle.arguments !== undefined) existing.arguments = lifecycle.arguments;
			continue;
		}
		requests.push({
			id: lifecycle.id || `anonymous-start-${lifecycleOrdinal}`,
			toolName: lifecycle.toolName,
			arguments: lifecycle.arguments,
			source: "start",
		});
		lifecycleOrdinal++;
	}
	// Duplicate assistant call IDs remain independent logical requests; a
	// lifecycle record only pairs with the first still-unmatched call.
	return requests;
}

function failedValue(value: unknown): boolean {
	if (value === true || value === "true" || value === 1) return true;
	if (value === false || value === "false" || value === 0 || value === "") return false;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["ok", "success", "successful", "completed", "done", "passed"].includes(normalized)) return false;
		return normalized.length > 0;
	}
	return isObject(value);
}

function failedToolEnd(record: JsonObject): boolean {
	let failed = false;
	if (record.isError !== undefined) failed ||= failedValue(record.isError);
	if (record.error !== undefined) failed ||= failedValue(record.error);
	if (record.errorMessage !== undefined) failed ||= failedValue(record.errorMessage);
	if (record.success !== undefined) failed ||= record.success === false || record.success === "false" || record.success === 0;
	if (typeof record.status === "string") failed ||= /error|fail|cancel|timeout|abort/i.test(record.status);
	return failed;
}

function runIdFromResult(record: JsonObject, message: JsonObject | undefined): string | undefined {
	for (const details of [message?.details, record.details]) {
		if (!isObject(details)) continue;
		const runId = stringValue(details.runId) ?? stringValue(details.asyncId);
		if (runId) return runId;
	}
	return undefined;
}

function extractToolResults(records: JsonObject[]): ToolResult[] {
	const messageResults: ToolResult[] = [];
	const lifecycleResults: Array<ToolResult & { explicitId: boolean }> = [];
	for (const record of records) {
		const message = nestedMessage(record);
		const role = recordRole(record)?.toLowerCase();
		const kind = recordType(record)?.toLowerCase();
		const sourceEventType = stringValue(record.sourceEventType)?.toLowerCase();
		if (role === "toolresult" || role === "tool_result") {
			const id = toolCallId(message?.toolCallId ?? record.toolCallId);
			const failed = failedValue(message?.isError ?? record.isError)
				|| failedValue(message?.error ?? record.error)
				|| failedValue(message?.errorMessage ?? record.errorMessage);
			const runId = runIdFromResult(record, message);
			messageResults.push({
				id,
				toolName: toolName(message?.toolName ?? record.toolName),
				failed,
				...(runId ? { runId } : {}),
				source: "message",
			});
		}
		if (kind === "tool_end" || kind === "tool_result" || kind === "toolresult" || kind === "tool_execution_end" || sourceEventType === "tool_execution_end") {
			const id = toolCallId(record.toolCallId ?? record.id);
			lifecycleResults.push({
				id,
				explicitId: Boolean(id),
				toolName: toolName(record.toolName ?? record.name),
				failed: failedToolEnd(record),
				source: "end",
			});
		}
	}

	const results = [...messageResults];
	const matchedMessages = new Set<ToolResult>();
	const matchMessage = (predicate: (result: ToolResult) => boolean): ToolResult | undefined => {
		const match = messageResults.find((result) => !matchedMessages.has(result) && predicate(result));
		if (match) matchedMessages.add(match);
		return match;
	};
	for (const lifecycle of lifecycleResults) {
		const existing = lifecycle.explicitId
			? matchMessage((result) => result.id === lifecycle.id)
			: matchMessage((result) => lifecycle.toolName === "unknown-tool" || result.toolName === lifecycle.toolName);
		if (existing) {
			existing.failed ||= lifecycle.failed;
			continue;
		}
		results.push({
			id: lifecycle.id,
			toolName: lifecycle.toolName,
			failed: lifecycle.failed,
			source: "end",
		});
	}
	return results;
}

function blankToolMetric(): ToolMetric {
	return { requested: 0, persistedResults: 0, failedResults: 0, missingResults: 0, unmatchedResults: 0, duplicateResults: 0 };
}

function addToolMetric(target: ToolMetric, source: Partial<ToolMetric>): void {
	target.requested += source.requested ?? 0;
	target.persistedResults += source.persistedResults ?? 0;
	target.failedResults += source.failedResults ?? 0;
	target.missingResults += source.missingResults ?? 0;
	target.unmatchedResults += source.unmatchedResults ?? 0;
	target.duplicateResults += source.duplicateResults ?? 0;
}

function collectToolActivity(sessions: SessionFacts[]): ToolActivity {
	const activity = blankToolMetric() as ToolActivity;
	activity.byTool = {};
	for (const session of sessions) {
		const requests = session.requests;
		const results = session.results;
		const anonymousRequests = requests.filter((request) => request.id.startsWith("anonymous-") || request.id.startsWith("anonymous-start-"));
		const assignedAnonymous = new Set<ToolRequest>();
		for (const result of results) {
			if (result.id !== "") continue;
			const sameTool = anonymousRequests.find((request) => !assignedAnonymous.has(request) && request.toolName === result.toolName);
			const fallback = sameTool ?? anonymousRequests.find((request) => !assignedAnonymous.has(request));
			if (fallback) {
				result.id = fallback.id;
				assignedAnonymous.add(fallback);
			}
		}
		const resultQueues = new Map<string, ToolResult[]>();
		for (const result of results) {
			const queue = resultQueues.get(result.id) ?? [];
			queue.push(result);
			resultQueues.set(result.id, queue);
		}
		const matchedResults = new Set<ToolResult>();
		const matchedRequests = new Set<ToolRequest>();
		const metricByRequest = new Map<ToolRequest, ToolMetric>();

		for (const request of requests) {
			const requestMetric = metricByRequest.get(request) ?? blankToolMetric();
			requestMetric.requested = 1;
			metricByRequest.set(request, requestMetric);
			const queue = resultQueues.get(request.id) ?? [];
			const result = queue.find((candidate) => !matchedResults.has(candidate));
			if (result) {
				matchedResults.add(result);
				matchedRequests.add(request);
				requestMetric.persistedResults = 1;
				requestMetric.failedResults = result.failed ? 1 : 0;
			}
		}

		for (const request of requests) {
			const requestMetric = metricByRequest.get(request)!;
			if (!matchedRequests.has(request)) requestMetric.missingResults = 1;
			const destination = activity.byTool[request.toolName] ?? blankToolMetric();
			addToolMetric(destination, requestMetric);
			activity.byTool[request.toolName] = destination;
		}

		for (const result of results) {
			if (matchedResults.has(result)) continue;
			const destination = activity.byTool[result.toolName] ?? blankToolMetric();
			const duplicate = result.id !== "" && requests.some((request) => request.id === result.id);
			addToolMetric(destination, {
				persistedResults: 1,
				failedResults: result.failed ? 1 : 0,
				unmatchedResults: 1,
				duplicateResults: duplicate ? 1 : 0,
			});
			activity.byTool[result.toolName] = destination;
		}
	}
	for (const metric of Object.values(activity.byTool)) addToolMetric(activity, metric);
	const sortedByTool: Record<string, ToolMetric> = {};
	for (const name of Object.keys(activity.byTool).sort()) sortedByTool[name] = activity.byTool[name]!;
	activity.byTool = sortedByTool;
	return activity;
}

function blankSkillMetric(): SkillMetric {
	return { count: 0, names: [], byName: {} };
}

function addSkill(metric: SkillMetric, value: unknown): void {
	const name = skillName(value);
	metric.count++;
	metric.byName[name] = (metric.byName[name] ?? 0) + 1;
}

function skillName(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "unknown";
	let candidate = value.trim();
	const marker = candidate.toLowerCase().indexOf("skill.md");
	if (marker >= 0) {
		candidate = candidate.slice(0, marker).replace(/[\\/]+$/, "");
		candidate = candidate.slice(Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\")) + 1);
	}
	candidate = candidate.replace(/^skill[:/]/i, "").replace(/\.(md|markdown)$/i, "");
	candidate = candidate.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
	if (/password|secret|token|credential|api[_-]?key|bearer|private[_-]?key/i.test(candidate)) return "redacted";
	if (candidate === "__proto__" || Object.prototype.hasOwnProperty.call(Object.prototype, candidate)) return "unknown";
	return candidate || "unknown";
}

function skillNameFromArguments(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isObject(value)) return undefined;
	for (const key of ["skill", "skillName", "name"]) {
		if (typeof value[key] === "string") return value[key];
	}
	if (typeof value.path === "string" && /skill\.md$/i.test(value.path)) return value.path;
	return undefined;
}

function isSkillInvocationTool(name: string): boolean {
	const normalized = name.toLowerCase();
	return normalized === "skill" || normalized === "invoke_skill" || normalized === "run_skill" || normalized === "execute_skill" || normalized === "load_skill" || normalized.endsWith(":skill");
}

function isReadTool(name: string): boolean {
	const normalized = name.toLowerCase();
	return normalized === "read" || normalized === "read_file" || normalized === "file_read" || normalized.endsWith(":read");
}

const READ_FILE_ARGUMENT_KEYS = ["path", "file", "filePath", "file_path", "filename", "fileName"] as const;

function exactSkillFilePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim();
	const basename = candidate.split(/[\\/]/).pop();
	return basename?.toLowerCase() === "skill.md" ? candidate : undefined;
}

/**
 * Read evidence is limited to explicit file/path arguments. Do not recurse
 * through arbitrary metadata, commands, or other persisted argument values:
 * those may mention SKILL.md without being a file read.
 */
function skillFilePathFromArguments(value: unknown): string | undefined {
	const direct = exactSkillFilePath(value);
	if (direct) return direct;
	if (!isObject(value)) return undefined;
	for (const key of READ_FILE_ARGUMENT_KEYS) {
		const candidate = exactSkillFilePath(value[key]);
		if (candidate) return candidate;
	}
	return undefined;
}

function textFromContentItem(value: unknown): string | undefined {
	return isObject(value) && value.type === "text" ? stringValue(value.text) : undefined;
}

function explicitSkillMarkers(records: JsonObject[]): string[] {
	const found: string[] = [];
	for (const record of records) {
		if (recordRole(record) !== "user") continue;
		const message = nestedMessage(record);
		const values = contentItems(record).map(textFromContentItem).filter((value): value is string => Boolean(value));
		if (typeof record.text === "string") values.push(record.text);
		if (typeof record.content === "string") values.push(record.content);
		if (typeof message?.text === "string") values.push(message.text);
		if (typeof message?.content === "string") values.push(message.content);
		// A persisted record may mirror text in both a top-level field and the
		// nested message. Deduplicate those fields per record while preserving
		// repeated invocation records.
		for (const text of new Set(values)) {
			const matcher = /<skill\s+name=["']([^"']+)["'][^>]*>/gi;
			for (const match of text.matchAll(matcher)) found.push(match[1]!);
			// Persisted records may preserve the original slash command rather than
			// Pi's expanded <skill ...> block.
			const commandMatcher = /(?:^|\s)\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)\b/gi;
			for (const match of text.matchAll(commandMatcher)) found.push(match[1]!);
		}
	}
	return found;
}

function skillActivityFor(requests: ToolRequest[], records: JsonObject[]): SkillActivity {
	const explicitInvocations = blankSkillMetric();
	const skillFileReads = blankSkillMetric();
	let argumentReadEvidence = 0;
	for (const request of requests) {
		if (isSkillInvocationTool(request.toolName)) addSkill(explicitInvocations, skillNameFromArguments(request.arguments));
		// Only an exact SKILL.md basename in an explicit read file/path argument
		// establishes SKILL.md-read evidence. Commands and other metadata may
		// mention the filename without reading it.
		if (isReadTool(request.toolName)) {
			const argument = skillFilePathFromArguments(request.arguments);
			if (argument) {
				argumentReadEvidence++;
				addSkill(skillFileReads, argument);
			}
		}
	}
	for (const marker of explicitSkillMarkers(records)) addSkill(explicitInvocations, marker);
	for (const record of records) {
		if (recordRole(record) !== "assistant") continue;
		for (const item of contentItems(record)) {
			if (!isObject(item)) continue;
			const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
			if (itemType === "skill_invocation" || itemType === "skillinvocation" || itemType === "skill_use") {
				addSkill(explicitInvocations, skillNameFromArguments(item.arguments ?? item.input ?? item));
			}
		}
	}
	// A persisted lifecycle record may keep a redacted argsPreview when the
	// payload is intentionally omitted. Use only the marker as evidence while
	// retaining no preview or argument text in the resulting report.
	let previewReadEvidence = 0;
	for (const record of records) {
		const customType = stringValue(record.customType) ?? "";
		const kind = recordType(record) ?? "";
		if (/skill[-_: ]*(invok|use)|(?:invok|use)[-_: ]*skill/i.test(customType) || /^(skill[-_: ]*(invok|use)|skillinvocation)$/i.test(kind)) {
			addSkill(explicitInvocations, skillNameFromArguments(record.details ?? record.data ?? record));
		}
		if (kind !== "tool_start" && kind !== "tool_execution_start" && record.sourceEventType !== "tool_execution_start") continue;
		const name = toolName(record.toolName ?? record.name);
		if (!isReadTool(name)) continue;
		const preview = stringValue(record.argsPreview);
		if (exactSkillFilePath(preview)) previewReadEvidence++;
	}
	for (let index = argumentReadEvidence; index < previewReadEvidence; index++) addSkill(skillFileReads, undefined);
	for (const metric of [explicitInvocations, skillFileReads]) {
		const sortedByName: Record<string, number> = {};
		for (const name of Object.keys(metric.byName).sort()) sortedByName[name] = metric.byName[name]!;
		metric.byName = sortedByName;
		metric.names = Object.keys(metric.byName);
	}
	return { explicitInvocations, skillFileReads };
}

function isCompactionRecord(record: JsonObject): boolean {
	const kind = recordType(record)?.toLowerCase();
	const source = stringValue(record.sourceEventType)?.toLowerCase();
	return kind?.startsWith("compaction") === true || source?.startsWith("compaction") === true || kind === "compact" || kind === "branch_summary" && record.compacted === true;
}

function sessionHeader(records: JsonObject[]): JsonObject | undefined {
	return records.find((record) => {
		const kind = recordType(record)?.toLowerCase();
		return kind === "session" || kind === "session_header";
	});
}

function branchPointCount(records: JsonObject[]): number {
	const points = new Set<string>();
	const childrenByParent = new Map<string, number>();
	for (const record of records) {
		const parentId = stringValue(record.parentId);
		if (!parentId) continue;
		childrenByParent.set(parentId, (childrenByParent.get(parentId) ?? 0) + 1);
	}
	for (const [parentId, children] of childrenByParent) if (children > 1) points.add(parentId);
	let markerIndex = 0;
	for (const record of records) {
		const kind = recordType(record)?.toLowerCase();
		if (kind !== "branch" && kind !== "branch_created" && kind !== "branch_summary" && record.branch !== true) continue;
		const marker = stringValue(record.parentId) ?? stringValue(record.fromId) ?? stringValue(record.id) ?? `marker-${markerIndex}`;
		points.add(marker);
		markerIndex++;
	}
	return points.size;
}

function factsForSource(source: ChildSource | undefined, kind: "parent" | "child"): SessionFacts {
	const status = source?.status ?? "missing";
	if (!source?.file || status !== "available") {
		return {
			node: {
				kind,
				status,
				sessionId: null,
				runId: safeIdentifier(source?.runId),
				runIndex: safeIdentifier(source?.runIndex),
				agent: safeIdentifier(source?.agent),
				records: null,
				malformedLines: null,
				requestedToolCalls: null,
				persistedToolResults: null,
				failedToolResults: null,
				compactionCount: null,
				truncatedCount: null,
				branchPointCount: null,
				hasSessionHeader: null,
			},
			usage: null,
			requests: [],
			results: [],
			skills: null,
			compactionCount: 0,
			truncatedCount: 0,
			branchPointCount: 0,
		};
	}
	const parsed = readSession(source.file);
	if (parsed.status !== "available") {
		return factsForSource({ ...source, status: parsed.status }, kind);
	}
	const header = sessionHeader(parsed.records);
	const requests = extractToolRequests(parsed.records);
	const results = extractToolResults(parsed.records);
	const compactionCount = parsed.records.filter(isCompactionRecord).length;
	const branches = branchPointCount(parsed.records);
	return {
		parsed,
		node: {
			kind,
			status: "available",
			sessionId: safeIdentifier(header?.id),
			runId: safeIdentifier(source.runId ?? parsed.records.map((record) => record.runId).find((value) => typeof value === "string")),
			runIndex: safeIdentifier(source.runIndex),
			agent: safeIdentifier(source.agent ?? parsed.records.map((record) => record.agent).find((value) => typeof value === "string")),
			records: parsed.records.length,
			malformedLines: parsed.malformedLines,
			requestedToolCalls: requests.length,
			persistedToolResults: results.length,
			failedToolResults: results.filter((result) => result.failed).length,
			compactionCount,
			truncatedCount: parsed.truncatedCount,
			branchPointCount: branches,
			hasSessionHeader: Boolean(header),
		},
		usage: usageForParsedSession(parsed),
		requests,
		results,
		skills: skillActivityFor(requests, parsed.records),
		compactionCount,
		truncatedCount: parsed.truncatedCount,
		branchPointCount: branches,
	};
}

function directChildDirectories(root: string): string[] {
	try {
		if (fs.lstatSync(root).isSymbolicLink()) return [];
		return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(root, entry.name)).sort();
	} catch {
		return [];
	}
}

function childFileStatus(file: string): "available" | "missing" | "unreadable" {
	try {
		const stat = fs.lstatSync(file);
		// Symlinked child files are deliberately not followed. Treat them as
		// unreadable evidence rather than silently dropping a discovered child.
		return stat.isFile() && !stat.isSymbolicLink() ? "available" : "unreadable";
	} catch (error) {
		const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;
		return code === "ENOENT" ? "missing" : "unreadable";
	}
}

interface MissingChildDiscoveryOptions {
	/** Dynamic run roots can exist even when no child was materialized. */
	dynamicRunIds?: ReadonlySet<string>;
	/** Dynamic fanout may create an empty outer run root before materialization. */
	ignoreEmptyRunDirectories?: boolean;
}

function discoverMissingChildSources(root: string, childFileName: string, options: MissingChildDiscoveryOptions = {}): ChildSource[] {
	try {
		if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return [];
	} catch {
		return [];
	}
	const candidates: ChildSource[] = [];
	const seen = new Set<string>();
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		const hasExpectedFile = entries.some((entry) => entry.isFile() && entry.name === childFileName);
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const full = path.join(current, entry.name);
			stack.push(full);
			const isDynamicRunRoot = current === root && (
				options.ignoreEmptyRunDirectories === true
				|| options.dynamicRunIds?.has(entry.name) === true
			);
			if (!/^run-\d+$/.test(entry.name) || isDynamicRunRoot) continue;
			if (hasExpectedFile) continue;
			const expectedFile = path.join(full, childFileName);
			const status = childFileStatus(expectedFile);
			if (status === "available") continue;
			if (seen.has(full)) continue;
			seen.add(full);
			const relative = path.relative(root, full).split(path.sep);
			candidates.push({
				status,
				...(status === "unreadable" ? { file: expectedFile } : {}),
				runId: relative[0],
				runIndex: entry.name,
			});
		}
	}
	// A run directory without a run-N child is an ephemeral launch record: it
	// exists, but no persisted child session was ever produced. Dynamic fanout
	// creates this outer run root before it knows whether any item will run;
	// an empty root is therefore not evidence of an ephemeral child.
	for (const directory of directChildDirectories(root)) {
		const name = path.basename(directory);
		if (/^run-\d+$/.test(name)) continue;
		const descendants = discoverSessionDirectoryDescendants(directory, childFileName);
		if (descendants.files.length > 0 || descendants.runDirectories.length > 0) continue;
		if (options.ignoreEmptyRunDirectories === true || options.dynamicRunIds?.has(name) === true) continue;
		if (!seen.has(directory)) {
			seen.add(directory);
			candidates.push({ status: "ephemeral", runId: name });
		}
	}
	return candidates.sort(compareChildSources);
}

function discoverSessionDirectoryDescendants(root: string, childFileName: string): { files: string[]; runDirectories: string[] } {
	try {
		if (fs.lstatSync(root).isSymbolicLink()) return { files: [], runDirectories: [] };
	} catch {
		return { files: [], runDirectories: [] };
	}
	const files: string[] = [];
	const runDirectories: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				stack.push(full);
				if (/^run-\d+$/.test(entry.name)) runDirectories.push(full);
			} else if (entry.isFile() && !entry.isSymbolicLink() && entry.name === childFileName) files.push(full);
		}
	}
	return { files, runDirectories };
}

function compareChildSources(left: ChildSource, right: ChildSource): number {
	const leftKey = [left.runId ?? "", left.runIndex ?? "", left.file ?? "", left.status].join("\0");
	const rightKey = [right.runId ?? "", right.runIndex ?? "", right.file ?? "", right.status].join("\0");
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function discoverChildSources(parentFile: string, missingChildOptions: MissingChildDiscoveryOptions = {}): ChildSource[] {
	// P1 intentionally reads only the canonical child root derived from the
	// parent session path. Only regular session.jsonl files are evidence.
	const childFileName = "session.jsonl";
	const root = subagentSessionDirFor(parentFile);
	const files: ChildSource[] = [];
	for (const file of discoverSessionFiles(root, childFileName)) {
		const rel = path.relative(root, file).split(path.sep);
		const parsed = readSession(file);
		files.push({ status: parsed.status, file, runId: rel[0], runIndex: rel.find((part) => /^run-\d+$/.test(part)) });
	}
	files.push(...discoverMissingChildSources(root, childFileName, missingChildOptions));
	const deduped = new Map<string, ChildSource>();
	for (const source of files) {
		const key = source.file ?? `${source.status}:${source.runId ?? ""}:${source.runIndex ?? ""}`;
		if (!deduped.has(key)) deduped.set(key, source);
	}
	return [...deduped.values()].sort(compareChildSources);
}

function discoverSessionFiles(root: string, fileName: string): string[] {
	try {
		if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return [];
	} catch {
		return [];
	}
	const found: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full);
			else if (entry.isFile() && !entry.isSymbolicLink() && entry.name === fileName) found.push(full);
		}
	}
	return found.sort();
}

function hasNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveRepeatCount(value: unknown): number {
	if (value === undefined) return 1;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 0;
}

function isDynamicFanoutRequest(request: ToolRequest): boolean {
	if (!["subagent", "delegate", "spawn_agent", "run_agent"].includes(request.toolName.toLowerCase())) return false;
	if (!isObject(request.arguments)) return false;
	const action = typeof request.arguments.action === "string" ? request.arguments.action.toLowerCase() : "";
	if (action || !Array.isArray(request.arguments.chain)) return false;
	return request.arguments.chain.some((step) => isObject(step) && isObject(step.expand) && isObject(step.parallel) && !Array.isArray(step.parallel));
}

function hasDynamicFanout(requests: ToolRequest[]): boolean {
	return requests.some(isDynamicFanoutRequest);
}

function dynamicRunIdsFor(requests: ToolRequest[], results: ToolResult[]): Set<string> {
	const dynamicRequestIds = new Set(requests.filter(isDynamicFanoutRequest).map((request) => request.id));
	return new Set(
		results
			.filter((result) => dynamicRequestIds.has(result.id) && result.runId)
			.map((result) => result.runId!),
	);
}

function expectedDelegatedChildCount(requests: ToolRequest[]): number {
	let expected = 0;
	for (const request of requests) {
		if (!["subagent", "delegate", "spawn_agent", "run_agent"].includes(request.toolName.toLowerCase())) continue;
		if (!isObject(request.arguments)) continue;
		const args = request.arguments;
		const action = typeof args.action === "string" ? args.action.toLowerCase() : "";
		// Management/control calls (get, update, status, resume, etc.) inspect or
		// mutate an existing run; only execution-mode calls create a delegated
		// child whose missing session should be represented as ephemeral.
		if (action) continue;
		if (Array.isArray(args.tasks)) {
			for (const task of args.tasks) {
				if (!isObject(task) || (!hasNonBlankString(task.agent) && !hasNonBlankString(task.task))) continue;
				expected += positiveRepeatCount(task.count);
			}
			continue;
		}
		if (Array.isArray(args.chain)) {
			for (const step of args.chain) {
				if (!isObject(step)) continue;
				if (Array.isArray(step.parallel)) {
					for (const task of step.parallel) {
						if (!isObject(task) || (!hasNonBlankString(task.agent) && !hasNonBlankString(task.task))) continue;
						expected += positiveRepeatCount(task.count);
					}
				} else if (hasNonBlankString(step.agent)) {
					expected++;
				}
			}
			continue;
		}
		if (hasNonBlankString(args.task) || hasNonBlankString(args.agent)) expected++;
	}
	return expected;
}

function aggregateSkills(sessions: SessionFacts[]): SkillActivity | null {
	const available = sessions.filter((session) => session.skills !== null);
	if (available.length === 0) return null;
	const explicitInvocations = blankSkillMetric();
	const skillFileReads = blankSkillMetric();
	for (const session of available) {
		const skills = session.skills!;
		for (const [target, source] of [[explicitInvocations, skills.explicitInvocations], [skillFileReads, skills.skillFileReads]] as const) {
			target.count += source.count;
			for (const [name, count] of Object.entries(source.byName)) target.byName[name] = (target.byName[name] ?? 0) + count;
		}
	}
	for (const metric of [explicitInvocations, skillFileReads]) {
		const sortedByName: Record<string, number> = {};
		for (const name of Object.keys(metric.byName).sort()) sortedByName[name] = metric.byName[name]!;
		metric.byName = sortedByName;
		metric.names = Object.keys(metric.byName);
	}
	return { explicitInvocations, skillFileReads };
}

function aggregateToolActivity(sessions: SessionFacts[]): ToolActivity | null {
	const available = sessions.filter((session) => session.parsed);
	return available.length === 0 ? null : collectToolActivity(available);
}

function addNullableUsage(target: UsageTotals, source: UsageTotals | null): void {
	if (source) addUsageTotals(target, source);
}

function normalizeUsageTotals(usage: UsageTotals): UsageTotals {
	return { ...usage };
}

function reportStatus(parent: SessionFacts, children: SessionFacts[]): SessionReportStatus {
	if (parent.node.status !== "available") return "unavailable";
	if (parent.parsed?.malformedLines || parent.compactionCount > 0 || parent.truncatedCount > 0 || children.some((child) => child.node.status !== "available" || child.parsed?.malformedLines || child.compactionCount > 0 || child.truncatedCount > 0)) return "partial";
	return "ok";
}

function makeTopology(parent: SessionFacts, children: SessionFacts[]): SessionTopology {
	const all = [parent, ...children];
	return {
		parent: parent.node,
		children: children.map((child) => child.node),
		sessionCount: all.length,
		availableSessionCount: all.filter((session) => session.node.status === "available").length,
		missingSessionCount: all.filter((session) => session.node.status === "missing").length,
		ephemeralSessionCount: all.filter((session) => session.node.status === "ephemeral").length,
		unreadableSessionCount: all.filter((session) => session.node.status === "unreadable").length,
		compactedSessionCount: all.filter((session) => (session.compactionCount ?? 0) > 0).length,
		branchedSessionCount: all.filter((session) => (session.branchPointCount ?? 0) > 0).length,
		branchPointCount: all.reduce((sum, session) => sum + session.branchPointCount, 0),
	};
}

function makeEvidence(all: SessionFacts[]): SessionReportEvidence {
	return {
		source: "persisted-session-jsonl",
		readableFileCount: all.filter((session) => session.node.status === "available").length,
		unavailableFileCount: all.filter((session) => session.node.status !== "available").length,
		malformedLineCount: all.reduce((sum, session) => sum + (session.parsed?.malformedLines ?? 0), 0),
		compactionCount: all.reduce((sum, session) => sum + session.compactionCount, 0),
		truncatedCount: all.reduce((sum, session) => sum + session.truncatedCount, 0),
		branchPointCount: all.reduce((sum, session) => sum + session.branchPointCount, 0),
		usageIncludesPersistedRecordsOnly: true,
		promptsRedacted: true,
		argumentsRedacted: true,
		rawMessagesRedacted: true,
		secretsRedacted: true,
		gitLabScanned: false,
		mrDataIncluded: false,
	};
}

function unavailableParentFacts(): SessionFacts {
	return factsForSource({ status: "missing" }, "parent");
}

/**
 * Collect a deterministic report from the parent JSONL and canonical child
 * session JSONL. Dynamic collection timestamps are intentionally omitted: the
 * same bytes produce the same report bytes.
 */
export function collectSessionReport(sessionFile: string | undefined): SessionReport {
	if (!sessionFile) {
		const parent = unavailableParentFacts();
		return {
			schemaVersion: SESSION_REPORT_SCHEMA_VERSION,
			reportType: SESSION_REPORT_TYPE,
			status: "unavailable",
			usage: { status: "unknown", parent: null, subagents: null, total: null },
			topology: makeTopology(parent, []),
			tools: null,
			skills: null,
			evidence: makeEvidence([parent]),
		};
	}
	const parent = factsForSource({ file: sessionFile, status: "available" }, "parent");
	if (parent.node.status !== "available") {
		return {
			schemaVersion: SESSION_REPORT_SCHEMA_VERSION,
			reportType: SESSION_REPORT_TYPE,
			status: "unavailable",
			usage: { status: "unknown", parent: null, subagents: null, total: null },
			topology: makeTopology(parent, []),
			tools: null,
			skills: null,
			evidence: makeEvidence([parent]),
		};
	}
	const dynamicFanout = hasDynamicFanout(parent.requests);
	const dynamicRunIds = dynamicRunIdsFor(parent.requests, parent.results);
	// Dynamic steps are intentionally excluded from this count: maxItems is a
	// bound, not evidence that that many children ran. Static expectations can
	// still be represented by unresolved ephemeral nodes when their sessions
	// are absent.
	const expectedStaticChildren = expectedDelegatedChildCount(parent.requests);
	const childSources = discoverChildSources(sessionFile, {
		dynamicRunIds,
		// Directory-only outer roots are not child evidence and are ignored when
		// dynamic work is present. Static launches that lack a session are
		// represented below by bounded unresolved-* nodes.
		ignoreEmptyRunDirectories: dynamicFanout,
	});
	// Count static evidence independently from dynamic observations. A persisted
	// dynamic child must not consume the slot for a static delegation whose
	// session is missing; otherwise the static gap disappears when both kinds
	// of delegation happen to produce one discovered child.
	//
	// Canonical paths alone cannot link an observed child to a request. In a
	// mixed run without a parent-persisted dynamic run ID, an empty outer
	// directory is not evidence that an available source belongs to static work:
	// it may be the missing static run instead. Treat every available unlinked
	// source as dynamic lower-bound evidence and preserve every static
	// expectation as an unresolved slot. This is deliberately conservative: it
	// preserves an unresolved static slot rather than claiming a dynamic source
	// was static.
	const availableUnlinkedSources = childSources.filter((source) => source.status === "available" && !dynamicRunIds.has(source.runId ?? ""));
	const treatUnlinkedAvailableAsDynamic = dynamicFanout
		&& dynamicRunIds.size === 0
		&& availableUnlinkedSources.length > 0;
	const isUnlinkedDynamicSource = (source: ChildSource): boolean => treatUnlinkedAvailableAsDynamic
		&& source.status === "available"
		&& !dynamicRunIds.has(source.runId ?? "");
	const observedStaticChildren = childSources.filter((source) =>
		!dynamicRunIds.has(source.runId ?? "") && !isUnlinkedDynamicSource(source),
	).length;
	for (let index = observedStaticChildren; index < expectedStaticChildren; index++) {
		childSources.push({ status: "ephemeral", runId: `unresolved-${index + 1}` });
	}
	childSources.sort(compareChildSources);
	const children = childSources.map((source) => factsForSource(source, "child"));
	const all = [parent, ...children];
	const parentUsage = parent.usage;
	// Dynamic scope is known only when persisted evidence can be attributed to
	// the dynamic request. Normal runs persist the request's run ID in its result;
	// dynamic-only fixtures may have no result linkage, in which case an available
	// source is attributable to the dynamic step because no static child is
	// expected. In a mixed run without linkage, available unlinked sources are
	// conservatively treated as dynamic and static expectations remain explicit.
	// Static children alone must never close the scope.
	const linkedDynamicChild = childSources.some((source) => source.status === "available" && source.runId !== undefined && dynamicRunIds.has(source.runId));
	const unlinkedDynamicChild = dynamicFanout
		&& dynamicRunIds.size === 0
		&& availableUnlinkedSources.length > 0;
	const dynamicScopeKnown = !dynamicFanout || linkedDynamicChild || unlinkedDynamicChild;
	// A readable child contributes lower-bound evidence even when all recorded
	// usage fields are zero. If every discovered child is missing, unreadable,
	// or ephemeral, there is no child evidence to summarize as zero. Dynamic
	// fanout without an observed child is likewise unknown; its maxItems bound
	// does not prove that zero children ran.
	const hasReadableChildEvidence = children.some((child) => child.usage !== null);
	const childScopeKnown = dynamicScopeKnown;
	const subagentUsage = childScopeKnown && (children.length === 0 || hasReadableChildEvidence) ? emptyUsageTotals() : null;
	if (subagentUsage) {
		for (const child of children) addNullableUsage(subagentUsage, child.usage);
	}
	const totalUsage = emptyUsageTotals();
	addNullableUsage(totalUsage, parentUsage);
	addNullableUsage(totalUsage, subagentUsage);
	const normalizedParentUsage = parentUsage ? normalizeUsageTotals(parentUsage) : null;
	const normalizedSubagentUsage = subagentUsage ? normalizeUsageTotals(subagentUsage) : null;
	const normalizedTotalUsage = normalizeUsageTotals(totalUsage);
	const completeUsage = subagentUsage !== null
		&& children.every((child) => child.node.status === "available")
		&& parent.parsed?.malformedLines === 0
		&& parent.compactionCount === 0
		&& parent.truncatedCount === 0
		&& children.every((child) => child.parsed?.malformedLines === 0 && child.compactionCount === 0 && child.truncatedCount === 0);
	return {
		schemaVersion: SESSION_REPORT_SCHEMA_VERSION,
		reportType: SESSION_REPORT_TYPE,
		status: reportStatus(parent, children),
		usage: {
			status: completeUsage ? "complete" : "partial",
			parent: normalizedParentUsage,
			subagents: normalizedSubagentUsage,
			total: normalizedTotalUsage,
		},
		topology: makeTopology(parent, children),
		tools: aggregateToolActivity(all),
		skills: aggregateSkills(all),
		evidence: makeEvidence(all),
	};
}

function fmtInt(value: number | null): string {
	return value === null ? "unknown" : Math.round(value).toLocaleString("en-US");
}

function fmtCost(value: number | null): string {
	return value === null ? "unknown" : `$${value.toFixed(4)}`;
}

function usageLines(label: string, usage: UsageTotals | null): string[] {
	if (!usage) return [`- ${label}: unknown (session evidence unavailable)`];
	return [
		`- ${label}: ${fmtInt(usage.totalTokens)} tokens, ${fmtCost(usage.cost)}, ${fmtInt(usage.assistantMessages)} assistant messages, ${fmtInt(usage.sessionFiles)} session files`,
	];
}

function metricLine(metric: SkillMetric): string {
	return `${fmtInt(metric.count)}${metric.names.length > 0 ? ` (${metric.names.join(", ")})` : ""}`;
}

/** Render the stable, human-readable companion to a SessionReport. */
export function formatSessionReport(report: SessionReport): string {
	const lines: string[] = [
		"# Session report",
		"",
		`- Schema version: ${report.schemaVersion}`,
		`- Status: ${report.status}`,
		"",
		"## Usage",
	];
	lines.push(...usageLines("Parent", report.usage.parent));
	lines.push(...usageLines("Delegated children", report.usage.subagents));
	lines.push(...usageLines("Total", report.usage.total));
	lines.push(`- Completeness: ${report.usage.status}`);
	lines.push("", "## Session topology");
	lines.push(`- Sessions: ${fmtInt(report.topology.sessionCount)} (${fmtInt(report.topology.availableSessionCount)} available, ${fmtInt(report.topology.missingSessionCount)} missing, ${fmtInt(report.topology.ephemeralSessionCount)} ephemeral, ${fmtInt(report.topology.unreadableSessionCount)} unreadable)`);
	lines.push(`- Branched sessions: ${fmtInt(report.topology.branchedSessionCount)}; branch points: ${fmtInt(report.topology.branchPointCount)}`);
	lines.push(`- Compacted sessions: ${fmtInt(report.topology.compactedSessionCount)}`);
	lines.push("", "## Tool activity");
	if (!report.tools) {
		lines.push("- Tool evidence: unknown (session evidence unavailable)");
	} else {
		lines.push(`- Requested calls: ${fmtInt(report.tools.requested)}`);
		lines.push(`- Persisted results: ${fmtInt(report.tools.persistedResults)}`);
		lines.push(`- Failed results: ${fmtInt(report.tools.failedResults)}`);
		lines.push(`- Missing results: ${fmtInt(report.tools.missingResults)}`);
		lines.push(`- Unmatched results: ${fmtInt(report.tools.unmatchedResults)}`);
		lines.push(`- Duplicate results: ${fmtInt(report.tools.duplicateResults)}`);
		lines.push("", "| Tool | Requested | Results | Failed | Missing | Unmatched | Duplicate |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
		for (const name of Object.keys(report.tools.byTool).sort()) {
			const metric = report.tools.byTool[name]!;
			lines.push(`| ${name} | ${metric.requested} | ${metric.persistedResults} | ${metric.failedResults} | ${metric.missingResults} | ${metric.unmatchedResults} | ${metric.duplicateResults} |`);
		}
		if (Object.keys(report.tools.byTool).length === 0) lines.push("| none | 0 | 0 | 0 | 0 | 0 | 0 |");
	}
	lines.push("", "## Skills");
	if (!report.skills) {
		lines.push("- Skill evidence: unknown (session evidence unavailable)");
	} else {
		lines.push(`- Explicit invocations: ${metricLine(report.skills.explicitInvocations)}`);
		lines.push(`- SKILL.md reads: ${metricLine(report.skills.skillFileReads)}`);
	}
	lines.push("", "## Evidence and privacy");
	lines.push("- Source: persisted parent and delegated child session JSONL only.");
	lines.push(`- Readable JSONL files: ${fmtInt(report.evidence.readableFileCount)}; unavailable files: ${fmtInt(report.evidence.unavailableFileCount)}; malformed lines: ${fmtInt(report.evidence.malformedLineCount)}; truncation markers: ${fmtInt(report.evidence.truncatedCount)}.`);
	lines.push("- Prompts, arguments, raw messages, secrets, GitLab data, and MR arrays are not included.");
	return lines.join("\n");
}

/** Serialize with fixed indentation and a trailing newline for stable artifacts. */
export function serializeSessionReport(report: SessionReport): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}

function hashSessionPath(sessionFile: string | undefined): string {
	return crypto.createHash("sha256").update(sessionFile ?? "unavailable").digest("hex").slice(0, 24);
}

/** Default private destination; never depends on the repository working tree. */
export function defaultSessionReportArtifactDirectory(sessionFile?: string): string {
	return path.join(os.homedir(), ".pi", "session-reports", hashSessionPath(sessionFile));
}

function repositoryRootFor(candidate: string): string | undefined {
	let current = path.resolve(candidate);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function ensurePrivateArtifactDirectory(directory: string): string {
	const resolved = path.resolve(directory);
	let repositoryCandidate = resolved;
	try {
		// Resolve an existing symlink target before checking repository ancestry;
		// otherwise a path outside the repository could redirect writes into it.
		repositoryCandidate = fs.realpathSync(resolved);
	} catch {
		let current = resolved;
		while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
		try { repositoryCandidate = fs.realpathSync(current) + resolved.slice(current.length); } catch { /* use lexical path */ }
	}
	if (repositoryRootFor(repositoryCandidate)) throw new Error("session-report artifacts must be outside a git repository");
	fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(resolved, 0o700); } catch { /* best effort on filesystems without POSIX modes */ }
	return resolved;
}

function writePrivateFile(target: string, content: string): void {
	try {
		if (fs.lstatSync(target).isSymbolicLink()) throw new Error("session-report artifact target must not be a symlink");
	} catch (error) {
		if (error instanceof Error && error.message.includes("must not be a symlink")) throw error;
		// A new target is expected on the first write.
	}
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
		try { fs.chmodSync(temporary, 0o600); } catch { /* best effort on filesystems without POSIX modes */ }
		fs.renameSync(temporary, target);
	} finally {
		try { fs.unlinkSync(temporary); } catch { /* rename removes the temporary path on success */ }
	}
}

/** Write both deterministic report artifacts to a private, non-repository directory. */
export function writeSessionReportArtifacts(report: SessionReport, options: SessionReportArtifactOptions = {}, sessionFile?: string): SessionReportArtifactPaths {
	const directory = ensurePrivateArtifactDirectory(options.directory ?? defaultSessionReportArtifactDirectory(sessionFile));
	const jsonPath = path.join(directory, SESSION_REPORT_JSON_NAME);
	const markdownPath = path.join(directory, SESSION_REPORT_MARKDOWN_NAME);
	writePrivateFile(jsonPath, serializeSessionReport(report));
	writePrivateFile(markdownPath, `${formatSessionReport(report)}\n`);
	return { jsonPath, markdownPath };
}

// Descriptive aliases keep the small shared API convenient for extensions and
// offline fixture tests without introducing a second implementation owner.
export const buildSessionReport = collectSessionReport;
export const renderSessionReportMarkdown = formatSessionReport;
export const writeSessionReport = writeSessionReportArtifacts;

export const sessionReportInternals = {
	parseJsonlContent,
	extractToolRequests,
	extractToolResults,
	discoverChildSources,
	skillActivityFor,
	branchPointCount,
	usageForRecord,
	ensurePrivateArtifactDirectory,
};
