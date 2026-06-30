import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPhaseConfigs, type LaunchConfig, type RunnablePhase } from "./phase-config";

type Phase =
	| "IDLE"
	| "IMPLEMENT"
	| "VERIFY"
	| "REVIEW"
	| "CLOSE"
	| "RETRO"
	| "DONE"
	| "STOPPED"
	| "WAITING_DECISION";

type Verdict =
	| "PASS"
	| "PASS_WITH_NON_BLOCKING_NOTES"
	| "FAIL"
	| "INCONCLUSIVE"
	| "DONE"
	| "MR_CREATED";

type Decision = "repair" | "stop" | "accept_risk" | "continue" | "defer";
type IssueSource = "verify" | "review" | "close";

interface HistoryEntry {
	timestamp: number;
	phase: Phase;
	event: string;
	verdict?: Verdict;
	decision?: Decision;
	summary?: string;
	artifact?: string;
}

interface PendingIssue {
	source: IssueSource;
	phase: Phase;
	verdict: Verdict;
	summary: string;
	artifact?: string;
	recommendedDecision?: Decision;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	assistantMessages: number;
	sessionFiles: number;
}

type PhaseRounds = Record<RunnablePhase, number>;
type UsageAttribution = "exact" | "best-effort" | "phase-aggregate" | "unavailable";

interface ReportUsageSnapshot {
	currentSessionTotals?: UsageTotals;
	sinceDeliveryStart?: UsageTotals;
	usableCurrentSessionTotals?: UsageTotals;
	usableSinceDeliveryStart?: UsageTotals;
	attribution: UsageAttribution;
}

interface DeliveryReportJsonV1 {
	schemaVersion: 1;
	source: "delivery-state-machine";
	id: string;
	task: string | null;
	status: Phase;
	phase: Phase;
	artifactDir: string;
	cwd?: string;
	gitBranch?: string;
	gitRoot?: string;
	createdAt?: number;
	updatedAt: number;
	generatedAt: number;
	summaryMarkdownPath: string;
	history: HistoryEntry[];
	steps: DeliveryStep[];
	acceptedRisks: string[];
	pendingIssue: PendingIssue | null;
	usage: {
		currentSessionTotals: UsageTotals | null;
		sinceDeliveryStart: UsageTotals | null;
		attribution: UsageAttribution;
	};
}

interface ReportArtifacts {
	markdownPath?: string;
	jsonPath?: string;
	markdown: string;
	jsonWriteError?: string;
}

interface DeliveryStep {
	id: string;
	phase: RunnablePhase;
	attempt: number;
	childIndex?: number;
	childCount?: number;
	agent?: string;
	model?: string;
	thinking?: string;
	context?: string;
	status: "planned" | "reported";
	verdict?: Verdict;
	summary?: string;
	artifact?: string;
	startedAt: number;
	endedAt?: number;
	usageBefore?: UsageTotals;
	usageAfter?: UsageTotals;
	usageDelta?: UsageTotals;
	usageAttribution?: UsageAttribution;
}

interface DeliveryState {
	active: boolean;
	task?: string;
	phase: Phase;
	verifyRound: number;
	reviewRound: number;
	maxRepairRounds: number;
	maxPhaseRounds: PhaseRounds;
	artifactDir?: string;
	usageAtStart?: UsageTotals;
	cwd?: string;
	gitBranch?: string;
	gitRoot?: string;
	lastVerificationVerdict?: Verdict;
	lastReviewVerdict?: Verdict;
	readyToClose: boolean;
	pendingIssue?: PendingIssue;
	acceptedRisks: string[];
	history: HistoryEntry[];
	steps: DeliveryStep[];
	updatedAt: number;
}

interface ChildLaunch extends LaunchConfig {
	childPrompt: string;
}

interface NextAction {
	phase: Phase;
	agent?: string;
	model?: string;
	thinking?: string;
	context?: string;
	parallel?: ChildLaunch[];
	prompt: string;
	childPrompt: string;
	orchestratorInstruction: string;
	reportInstruction?: string;
}

const START_PARAMS = Type.Object({
	task: Type.String({ description: "User task, bug, issue URL, or requirement to deliver" }),
	maxRepairRounds: Type.Optional(Type.Number({ description: "Legacy override: maximum repair loops for every phase" })),
	maxRounds: Type.Optional(Type.Object({
		IMPLEMENT: Type.Optional(Type.Number({ description: "Maximum IMPLEMENT attempts before stopping" })),
		VERIFY: Type.Optional(Type.Number({ description: "Maximum VERIFY rounds before stopping" })),
		REVIEW: Type.Optional(Type.Number({ description: "Maximum REVIEW rounds before stopping" })),
		CLOSE: Type.Optional(Type.Number({ description: "Maximum CLOSE rounds before stopping" })),
		RETRO: Type.Optional(Type.Number({ description: "Maximum RETRO rounds before stopping" })),
	}, { description: "Per-phase maximum rounds. Overrides configured defaults for this delivery." })),
});

const REPORT_PARAMS = Type.Object({
	phase: StringEnum([
		"IMPLEMENT",
		"VERIFY",
		"REVIEW",
		"CLOSE",
		"RETRO",
	] as const),
	verdict: Type.Optional(
		StringEnum(["PASS", "PASS_WITH_NON_BLOCKING_NOTES", "FAIL", "INCONCLUSIVE", "DONE", "MR_CREATED"] as const),
	),
	summary: Type.String({ description: "Concise evidence-backed report from the completed state" }),
	artifact: Type.Optional(Type.String({ description: "Artifact path, MR URL, or saved output reference" })),
	recommendedDecision: Type.Optional(
		StringEnum(["repair", "stop", "accept_risk", "continue", "defer"] as const),
	),
});

const DECIDE_PARAMS = Type.Object({
	decision: StringEnum(["repair", "stop", "accept_risk", "continue", "defer"] as const),
	rationale: Type.Optional(Type.String({ description: "Why this decision is appropriate" })),
});

const EMPTY_PARAMS = Type.Object({});

const RUNNABLE_PHASES: RunnablePhase[] = ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"];
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_PHASE_ROUNDS: PhaseRounds = {
	IMPLEMENT: DEFAULT_MAX_ROUNDS,
	VERIFY: DEFAULT_MAX_ROUNDS,
	REVIEW: DEFAULT_MAX_ROUNDS,
	CLOSE: DEFAULT_MAX_ROUNDS,
	RETRO: DEFAULT_MAX_ROUNDS,
};

function allPhaseRounds(value: number): PhaseRounds {
	return Object.fromEntries(RUNNABLE_PHASES.map((phase) => [phase, value])) as PhaseRounds;
}

const initialState = (): DeliveryState => ({
	active: false,
	phase: "IDLE",
	verifyRound: 0,
	reviewRound: 0,
	maxRepairRounds: DEFAULT_MAX_ROUNDS,
	maxPhaseRounds: { ...DEFAULT_PHASE_ROUNDS },
	readyToClose: false,
	acceptedRisks: [],
	history: [],
	steps: [],
	updatedAt: Date.now(),
});

function cloneState(state: DeliveryState): DeliveryState {
	return JSON.parse(JSON.stringify(state)) as DeliveryState;
}

function normalizeRound(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(1, Math.floor(value));
}

function normalizePhaseRounds(raw: unknown): Partial<PhaseRounds> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Partial<PhaseRounds> = {};
	for (const phase of RUNNABLE_PHASES) {
		const value = normalizeRound((raw as Record<string, unknown>)[phase]);
		if (value !== undefined) out[phase] = value;
	}
	return out;
}

function normalizeState(raw?: Partial<DeliveryState>): DeliveryState {
	const base = initialState();
	if (!raw) return base;
	const legacyAllRounds = raw.maxPhaseRounds ? undefined : normalizeRound(raw.maxRepairRounds);
	const maxPhaseRounds = legacyAllRounds !== undefined
		? allPhaseRounds(legacyAllRounds)
		: { ...DEFAULT_PHASE_ROUNDS, ...normalizePhaseRounds(raw.maxPhaseRounds) };
	return {
		...base,
		...raw,
		maxRepairRounds: maxPhaseRounds.VERIFY,
		maxPhaseRounds,
		acceptedRisks: Array.isArray(raw.acceptedRisks) ? raw.acceptedRisks : [],
		history: Array.isArray(raw.history) ? raw.history : [],
		steps: Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: DeliveryStep[] }).steps : [],
	};
}

function maxRoundsForPhase(state: DeliveryState, phase: RunnablePhase): number {
	return state.maxPhaseRounds?.[phase] ?? state.maxRepairRounds ?? DEFAULT_MAX_ROUNDS;
}

function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, assistantMessages: 0, sessionFiles: 0 };
}

function addUsage(into: UsageTotals, usage: Partial<UsageTotals>) {
	into.input += usage.input ?? 0;
	into.output += usage.output ?? 0;
	into.cacheRead += usage.cacheRead ?? 0;
	into.cacheWrite += usage.cacheWrite ?? 0;
	into.totalTokens += usage.totalTokens ?? 0;
	into.cost += usage.cost ?? 0;
	into.assistantMessages += usage.assistantMessages ?? 0;
	into.sessionFiles += usage.sessionFiles ?? 0;
}

function subtractUsage(current: UsageTotals, baseline: UsageTotals): UsageTotals {
	return {
		input: Math.max(0, current.input - baseline.input),
		output: Math.max(0, current.output - baseline.output),
		cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
		cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
		totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
		cost: Math.max(0, current.cost - baseline.cost),
		assistantMessages: Math.max(0, current.assistantMessages - baseline.assistantMessages),
		sessionFiles: Math.max(0, current.sessionFiles - baseline.sessionFiles),
	};
}

function collectJsonlFiles(dir: string, out: string[]) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) collectJsonlFiles(fullPath, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(fullPath);
	}
}

function collectUsageFromSessionFile(sessionFile: string): UsageTotals {
	const totals = emptyUsageTotals();
	if (!fs.existsSync(sessionFile)) return totals;
	totals.sessionFiles = 1;
	for (const line of fs.readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: any } };
			const usage = entry.type === "message" && entry.message?.role === "assistant" ? entry.message.usage : undefined;
			if (!usage) continue;
			const input = Number(usage.input ?? 0);
			const output = Number(usage.output ?? 0);
			const cacheRead = Number(usage.cacheRead ?? 0);
			const cacheWrite = Number(usage.cacheWrite ?? 0);
			const totalTokens = Number(usage.totalTokens ?? input + output + cacheRead + cacheWrite);
			const cost = Number(usage.cost?.total ?? 0);
			addUsage(totals, { input, output, cacheRead, cacheWrite, totalTokens, cost, assistantMessages: 1 });
		} catch {
			// Ignore malformed/non-JSON lines so one bad entry does not break summary reporting.
		}
	}
	return totals;
}

function collectSessionUsage(ctx: ExtensionContext): UsageTotals | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return undefined;
	const totals = collectUsageFromSessionFile(sessionFile);
	const subagentDir = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : `${sessionFile}.d`;
	const subagentFiles: string[] = [];
	collectJsonlFiles(subagentDir, subagentFiles);
	for (const file of subagentFiles) addUsage(totals, collectUsageFromSessionFile(file));
	return totals;
}

function formatNumber(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function formatCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function formatUsage(totals: UsageTotals): string {
	return [
		`tokens ${formatNumber(totals.totalTokens)}`,
		`input ${formatNumber(totals.input)}`,
		`output ${formatNumber(totals.output)}`,
		`cache read ${formatNumber(totals.cacheRead)}`,
		`cache write ${formatNumber(totals.cacheWrite)}`,
		`cost ${formatCost(totals.cost)}`,
		`assistant messages ${formatNumber(totals.assistantMessages)}`,
		`session files ${formatNumber(totals.sessionFiles)}`,
	].join(" | ");
}

function gitOutput(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function refreshGitInfo(ctx: ExtensionContext, state: DeliveryState) {
	state.cwd = ctx.cwd;
	if (gitOutput(ctx.cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
		state.gitBranch = undefined;
		state.gitRoot = undefined;
		return;
	}
	state.gitRoot = gitOutput(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	const branch = gitOutput(ctx.cwd, ["branch", "--show-current"]);
	state.gitBranch = branch || `detached@${gitOutput(ctx.cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown"}`;
}

function truncate(text: string | undefined, max = 500): string {
	if (!text) return "";
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function slugifyTask(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "task";
}

function datePrefix(now = new Date()): string {
	const dd = String(now.getDate()).padStart(2, "0");
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const yyyy = String(now.getFullYear());
	return `${dd}-${mm}-${yyyy}`;
}

interface DeliveryConfig {
	artifactRoot?: string;
	artifactRootBaseDir?: string;
	maxRounds?: Partial<PhaseRounds>;
}

const DEFAULT_ARTIFACT_ROOT = path.join(os.homedir(), ".pi", "delivery-run");

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, os.homedir()) ?? path.join(os.homedir(), ".pi", "agent");
}

function readDeliveryConfigFile(filePath: string, artifactRootBaseDir: string): Partial<DeliveryConfig> {
	if (!fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
			artifactRoot?: unknown;
			artifactRootDir?: unknown;
			maxRepairRounds?: unknown;
			maxRounds?: unknown;
			phaseMaxRounds?: unknown;
		};
		const artifactRoot = typeof parsed.artifactRoot === "string"
			? parsed.artifactRoot
			: typeof parsed.artifactRootDir === "string"
				? parsed.artifactRootDir
				: undefined;
		const allRounds = normalizeRound(parsed.maxRepairRounds);
		const maxRounds = {
			...(allRounds !== undefined ? allPhaseRounds(allRounds) : {}),
			...normalizePhaseRounds(parsed.maxRounds),
			...normalizePhaseRounds(parsed.phaseMaxRounds),
		};
		return {
			...(artifactRoot ? { artifactRoot, artifactRootBaseDir } : {}),
			...(Object.keys(maxRounds).length ? { maxRounds } : {}),
		};
	} catch (error) {
		console.error(`Warning: could not parse delivery-state-machine config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function mergeDeliveryConfig(base: DeliveryConfig, override: Partial<DeliveryConfig>): DeliveryConfig {
	return {
		...base,
		...override,
		maxRounds: { ...(base.maxRounds ?? {}), ...(override.maxRounds ?? {}) },
	};
}

function loadDeliveryConfig(cwd: string): DeliveryConfig {
	const agentDir = getAgentDir();
	const globalConfigPath = path.join(agentDir, "extensions", "delivery-state-machine.json");
	const projectConfigPath = path.join(cwd, ".pi", "delivery-state-machine.json");
	let config: DeliveryConfig = {};
	config = mergeDeliveryConfig(config, readDeliveryConfigFile(globalConfigPath, agentDir));
	config = mergeDeliveryConfig(config, readDeliveryConfigFile(projectConfigPath, cwd));
	if (process.env.PI_DELIVERY_ARTIFACT_ROOT) {
		config.artifactRoot = process.env.PI_DELIVERY_ARTIFACT_ROOT;
		config.artifactRootBaseDir = cwd;
	}
	return config;
}

function expandArtifactRoot(root: string, cwd: string): string {
	return root
		.replace(/^~(?=$|\/)/, os.homedir())
		.replace(/\$\{home\}/g, os.homedir())
		.replace(/\$\{cwd\}/g, cwd);
}

function resolveArtifactRoot(cwd: string, config: DeliveryConfig): string {
	const configuredRoot = config.artifactRoot?.trim();
	if (!configuredRoot) return DEFAULT_ARTIFACT_ROOT;
	const expanded = expandArtifactRoot(configuredRoot, cwd);
	if (path.isAbsolute(expanded)) return expanded;
	return path.resolve(config.artifactRootBaseDir ?? cwd, expanded);
}

function resolveMaxPhaseRounds(config: DeliveryConfig, maxRepairRounds?: unknown, maxRounds?: unknown): PhaseRounds {
	const allRounds = normalizeRound(maxRepairRounds);
	return {
		...DEFAULT_PHASE_ROUNDS,
		...(config.maxRounds ?? {}),
		...(allRounds !== undefined ? allPhaseRounds(allRounds) : {}),
		...normalizePhaseRounds(maxRounds),
	};
}

function createArtifactDir(cwd: string, task: string): string {
	const root = resolveArtifactRoot(cwd, loadDeliveryConfig(cwd));
	const baseName = `${datePrefix()}-${slugifyTask(task)}`;
	let candidate = path.join(root, baseName);
	let suffix = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(root, `${baseName}-${suffix++}`);
	}
	fs.mkdirSync(candidate, { recursive: true });
	return candidate;
}

function extensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function renderTemplate(template: string, values: Record<string, string | undefined>): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}

function readPromptTemplate(filename: string): string {
	return fs.readFileSync(path.join(extensionDir(), "prompts", filename), "utf8");
}

function renderDeliverPrompt(state: DeliveryState): string {
	return renderTemplate(readPromptTemplate("deliver.md"), {
		task: state.task ?? "<missing task>",
		artifactDir: state.artifactDir ?? "<missing artifact dir>",
	});
}

function artifactGuidance(state: DeliveryState): string {
	if (!state.artifactDir) return "";
	return `\n\nArtifact guidance:\n- User-scope artifact directory for this delivery run: ${state.artifactDir}.\n- Save or report the artifact path under this directory, e.g. 01-implementation.md, 02-verification.md, 03-review.md, 04-close.md, 05-retro.md.\n- Keep artifacts scan-friendly: start with verdict/result, then required checklist, blockers, non-blocking notes, and concise evidence.`;
}

function isPass(verdict?: Verdict): boolean {
	return verdict === "PASS" || verdict === "PASS_WITH_NON_BLOCKING_NOTES" || verdict === "DONE" || verdict === "MR_CREATED";
}

function isFail(verdict?: Verdict): boolean {
	return verdict === "FAIL" || verdict === "INCONCLUSIVE";
}

function completedImplementationReports(state: DeliveryState): number {
	return state.history.filter((entry) => entry.event === "report" && entry.phase === "IMPLEMENT").length;
}

function implementationAttempt(state: DeliveryState): number {
	return completedImplementationReports(state) + (state.active && state.phase === "IMPLEMENT" ? 1 : 0);
}

function hasImplementRepairBudget(state: DeliveryState): boolean {
	return completedImplementationReports(state) < maxRoundsForPhase(state, "IMPLEMENT");
}

function phaseLabel(state: DeliveryState): string {
	if (!state.active) return "idle";
	let label = state.phase.toLowerCase().replace(/_/g, "-");
	if (state.phase === "IMPLEMENT") label += ` attempt ${implementationAttempt(state)}/${maxRoundsForPhase(state, "IMPLEMENT")}`;
	if (state.phase === "VERIFY") label += ` attempt ${state.verifyRound}/${maxRoundsForPhase(state, "VERIFY")}`;
	if (state.phase === "REVIEW") label += ` attempt ${state.reviewRound}/${maxRoundsForPhase(state, "REVIEW")}`;
	return label;
}

function statusText(state: DeliveryState): string {
	if (!state.active) return `Delivery: idle${state.gitBranch ? ` | branch: ${state.gitBranch}` : ""}`;
	const bits = [`Delivery: ${phaseLabel(state)}`];
	if (state.gitBranch) bits.push(`branch: ${state.gitBranch}`);
	if (state.pendingIssue) bits.push(`waiting: ${state.pendingIssue.source}`);
	if (state.readyToClose) bits.push("ready-to-close");
	return bits.join(" | ");
}

function updateUi(ctx: ExtensionContext, state: DeliveryState) {
	refreshGitInfo(ctx, state);
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const status = state.phase === "STOPPED"
		? theme.fg("warning", statusText(state))
		: state.phase === "DONE"
			? theme.fg("success", statusText(state))
			: theme.fg("accent", statusText(state));
	ctx.ui.setStatus("delivery-sm", status);
	if (state.active && state.phase !== "DONE" && state.phase !== "STOPPED") {
		ctx.ui.setWidget("delivery-sm", [truncate(state.task, 160)]);
	} else {
		ctx.ui.setWidget("delivery-sm", undefined);
	}
}

function addHistory(state: DeliveryState, entry: Omit<HistoryEntry, "timestamp">) {
	state.history.push({ timestamp: Date.now(), ...entry });
	state.updatedAt = Date.now();
}

function isRunnablePhase(phase: Phase): phase is RunnablePhase {
	return RUNNABLE_PHASES.includes(phase as RunnablePhase);
}

function phasePromptContext(state: DeliveryState) {
	return {
		task: state.task ?? "<missing task>",
		artifactGuidance: artifactGuidance(state),
		verifyRound: state.verifyRound,
		maxRepairRounds: isRunnablePhase(state.phase) ? maxRoundsForPhase(state, state.phase) : maxRoundsForPhase(state, "VERIFY"),
		pendingIssueSummary: state.pendingIssue?.summary,
		pendingIssueInstruction: state.pendingIssue
			? `Pending ${state.pendingIssue.source} issue to address before re-running verify/review:\n${state.pendingIssue.summary}`
			: "No pending verify/review issue; implement the original task.",
	};
}

const CHILD_PROMPT_FOOTER = `

Common workflow instruction:
- Return your result and evidence to the parent/orchestrator.
- Do not call delivery_report; the parent/orchestrator will call delivery_report to advance the workflow after you finish.`;

const PHASE_ARTIFACT_STEMS: Record<RunnablePhase, string> = {
	IMPLEMENT: "01-implementation",
	VERIFY: "02-verification",
	REVIEW: "03-review",
	CLOSE: "04-close",
	RETRO: "05-retro",
};

function slugifyLaunch(launch: LaunchConfig): string {
	return [launch.agent, launch.model, launch.thinking, launch.context]
		.filter(Boolean)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "child";
}

function parallelArtifactName(phase: RunnablePhase, attempt: number, launch: LaunchConfig, childIndex: number): string {
	const childNumber = String(childIndex + 1).padStart(2, "0");
	return `${PHASE_ARTIFACT_STEMS[phase]}-${attempt}-${childNumber}-${slugifyLaunch(launch)}.md`;
}

function parallelChildPrompt(basePrompt: string, state: DeliveryState, launch: LaunchConfig, index: number, total: number): string {
	if (!isRunnablePhase(state.phase)) return basePrompt;
	const attempt = phaseAttemptForStep(state, state.phase);
	const artifactName = parallelArtifactName(state.phase, attempt, launch, index);
	const artifactPath = state.artifactDir ? path.join(state.artifactDir, artifactName) : artifactName;
	return `${basePrompt}

Parallel phase instruction:
- You are child ${index + 1}/${total} for phase ${state.phase} attempt ${attempt}; work independently from the other parallel child outputs.
- Use or return this unique attempt-specific artifact path for your result: ${artifactPath}.
- Do not write to the generic phase artifact path such as ${PHASE_ARTIFACT_STEMS[state.phase]}.md; the parent/orchestrator may use that for the aggregate phase report.`;
}

function reportInstructionForPhase(phase: RunnablePhase, parallelCount = 1): string {
	const verdictGuidance = phase === "VERIFY" ? " and verdict PASS/FAIL/INCONCLUSIVE" : "";
	if (parallelCount > 1) {
		return `After all ${parallelCount} children complete, parent/orchestrator aggregates their findings and calls delivery_report once with phase ${phase}${verdictGuidance}. For REVIEW, report FAIL with recommendedDecision=repair if any reviewer identifies a must-fix finding.`;
	}
	return `After the child completes, parent/orchestrator calls delivery_report with phase ${phase}${verdictGuidance}.`;
}

function worktreePolicyInstruction(state: DeliveryState): string | undefined {
	if (state.phase !== "IMPLEMENT") return undefined;
	return "Before launching implementation, ensure repository work happens in a dedicated git worktree created from latest main unless this delivery is continuing the same task or an amended requirement. If the current cwd/branch is not that worktree, create/switch to one or launch the child with that worktree cwd when supported. For non-git or non-repo tasks, record why this policy is not applicable.";
}

function fallbackNextPrompt(state: DeliveryState): string {
	switch (state.phase) {
		case "WAITING_DECISION":
			return `Ask the user/parent for a decision on pending ${state.pendingIssue?.source} issue: repair / stop / accept_risk / defer / continue. Then call delivery_decide.`;
		case "DONE":
			return "Delivery state machine is complete.";
		case "STOPPED":
			return "Delivery state machine is stopped. Do not continue unless the user starts/resets it.";
		default:
			return "No active delivery. Use /deliver <task> or delivery_start.";
	}
}

function nextAction(state: DeliveryState): NextAction {
	if (!isRunnablePhase(state.phase)) {
		const prompt = fallbackNextPrompt(state);
		return {
			phase: state.phase,
			prompt,
			childPrompt: prompt,
			orchestratorInstruction: prompt,
		};
	}

	const config = loadPhaseConfigs(state.cwd ?? process.cwd(), state.gitRoot)[state.phase];
	const context = phasePromptContext(state);
	const childPrompt = `${config.childPrompt(context)}${CHILD_PROMPT_FOOTER}`;
	const launches = config.launches;
	const [primaryLaunch] = launches;
	const parallel = launches.length > 1
		? launches.map((launch, index, allLaunches) => ({
			...launch,
			childPrompt: parallelChildPrompt(childPrompt, state, launch, index, allLaunches.length),
		}))
		: undefined;
	const orchestratorInstruction = [worktreePolicyInstruction(state), config.orchestratorInstruction(context)].filter(Boolean).join(" ");
	const reportInstruction = reportInstructionForPhase(state.phase, launches.length);
	return {
		phase: state.phase,
		agent: primaryLaunch.agent,
		model: primaryLaunch.model,
		thinking: primaryLaunch.thinking,
		context: primaryLaunch.context,
		parallel,
		prompt: childPrompt,
		childPrompt,
		orchestratorInstruction,
		reportInstruction,
	};
}

function phaseAttemptForStep(state: DeliveryState, phase: RunnablePhase): number {
	if (phase === "IMPLEMENT") return implementationAttempt(state);
	if (phase === "VERIFY") return Math.max(1, state.verifyRound || 1);
	if (phase === "REVIEW") return Math.max(1, state.reviewRound || 1);
	return state.history.filter((entry) => entry.event === "report" && entry.phase === phase).length + 1;
}

function plannedStepId(phase: RunnablePhase, attempt: number, childIndex?: number): string {
	return `${phase}-${attempt}-${childIndex ?? 0}`;
}

function plannedArtifactPath(state: DeliveryState, phase: RunnablePhase, attempt: number, launch?: LaunchConfig, childIndex?: number, childCount?: number): string | undefined {
	if (!state.artifactDir) return undefined;
	const stem = PHASE_ARTIFACT_STEMS[phase];
	let fileName: string;
	if (childCount && childCount > 1 && launch && childIndex !== undefined) {
		fileName = parallelArtifactName(phase, attempt, launch, childIndex);
	} else {
		fileName = attempt > 1 ? `${stem}-${attempt}.md` : `${stem}.md`;
	}
	return path.join(state.artifactDir, fileName);
}

function recordPlannedSteps(state: DeliveryState, ctx: ExtensionContext, action: NextAction) {
	if (!isRunnablePhase(action.phase)) return;
	const phase = action.phase;
	const attempt = phaseAttemptForStep(state, phase);
	const usageBefore = collectSessionUsage(ctx);
	const fallbackLaunch = loadPhaseConfigs(state.cwd ?? process.cwd(), state.gitRoot)[phase].launches[0];
	const launches = action.parallel?.length
		? action.parallel
		: [{ agent: action.agent ?? fallbackLaunch.agent, model: action.model, thinking: action.thinking, context: action.context }];
	launches.forEach((launch, index) => {
		const childCount = launches.length;
		const childIndex = childCount > 1 ? index : undefined;
		const id = plannedStepId(phase, attempt, childIndex);
		if (state.steps.some((step) => step.id === id)) return;
		state.steps.push({
			id,
			phase,
			attempt,
			childIndex,
			childCount: childCount > 1 ? childCount : undefined,
			agent: launch.agent,
			model: launch.model,
			thinking: launch.thinking,
			context: launch.context,
			status: "planned",
			artifact: plannedArtifactPath(state, phase, attempt, launch, childIndex, childCount),
			startedAt: Date.now(),
			usageBefore,
		});
	});
	state.updatedAt = Date.now();
}

function ensurePlannedStepsForReport(state: DeliveryState, ctx: ExtensionContext, phase: RunnablePhase): DeliveryStep[] {
	const attempt = phaseAttemptForStep(state, phase);
	let steps = state.steps.filter((step) => step.phase === phase && step.attempt === attempt && step.status === "planned");
	if (steps.length) return steps;
	const action = nextAction(state);
	recordPlannedSteps(state, ctx, action.phase === phase ? action : { ...action, phase });
	steps = state.steps.filter((step) => step.phase === phase && step.attempt === attempt && step.status === "planned");
	return steps;
}

function usageDeltaForStep(step: DeliveryStep, usageAfter: UsageTotals | undefined): UsageTotals | undefined {
	if (!usageAfter || !step.usageBefore) return undefined;
	return subtractUsage(usageAfter, step.usageBefore);
}

function usageAttributionForStep(step: DeliveryStep, usageAfter: UsageTotals | undefined, parallel: boolean): UsageAttribution {
	const delta = usageDeltaForStep(step, usageAfter);
	if (!delta || delta.assistantMessages === 0) return "unavailable";
	return parallel ? "phase-aggregate" : "best-effort";
}

function recordReportedSteps(state: DeliveryState, ctx: ExtensionContext, params: { phase: Phase; verdict?: Verdict; summary: string; artifact?: string }) {
	if (!isRunnablePhase(params.phase)) return;
	const steps = ensurePlannedStepsForReport(state, ctx, params.phase);
	const usageAfter = collectSessionUsage(ctx);
	const parallel = steps.length > 1;
	const endedAt = Date.now();
	for (const step of steps) {
		step.status = "reported";
		step.verdict = parallel ? undefined : params.verdict;
		step.summary = parallel ? undefined : truncate(params.summary, 800);
		if (params.artifact && steps.length === 1) step.artifact = params.artifact;
		step.endedAt = endedAt;
		step.usageAfter = usageAfter;
		step.usageAttribution = usageAttributionForStep(step, usageAfter, parallel);
		if (usageAfter && step.usageBefore && step.usageAttribution !== "unavailable") {
			step.usageDelta = subtractUsage(usageAfter, step.usageBefore);
		}
	}
	if (parallel) {
		const aggregateId = `${params.phase}-${steps[0]?.attempt ?? phaseAttemptForStep(state, params.phase)}-aggregate`;
		const existing = state.steps.find((step) => step.id === aggregateId);
		const usageBefore = steps[0]?.usageBefore;
		const aggregate: DeliveryStep = existing ?? {
			id: aggregateId,
			phase: params.phase,
			attempt: steps[0]?.attempt ?? phaseAttemptForStep(state, params.phase),
			agent: "aggregate",
			model: "parent",
			status: "reported",
			startedAt: Math.min(...steps.map((step) => step.startedAt)),
			usageBefore,
		};
		aggregate.status = "reported";
		aggregate.verdict = params.verdict;
		aggregate.summary = truncate(params.summary, 800);
		if (params.artifact) aggregate.artifact = params.artifact;
		aggregate.endedAt = endedAt;
		aggregate.usageAfter = usageAfter;
		aggregate.usageAttribution = usageAttributionForStep(aggregate, usageAfter, true);
		if (usageAfter && aggregate.usageBefore && aggregate.usageAttribution !== "unavailable") {
			aggregate.usageDelta = subtractUsage(usageAfter, aggregate.usageBefore);
		}
		if (!existing) state.steps.push(aggregate);
	}
	state.updatedAt = Date.now();
}

function formatNextAction(state: DeliveryState): string {
	const action = nextAction(state);
	if (!isRunnablePhase(state.phase)) return action.orchestratorInstruction;
	const launchOne = (launch: { agent?: string; model?: string; thinking?: string; context?: string }) => [
		`agent=${launch.agent}`,
		launch.model ? `model=${launch.model}` : undefined,
		launch.thinking ? `thinking=${launch.thinking}` : undefined,
		launch.context ? `context=${launch.context}` : undefined,
	].filter(Boolean).join(", ");
	const launch = action.parallel?.length
		? `parallel (${action.parallel.length}): ${action.parallel.map(launchOne).join(" | ")}`
		: launchOne(action);
	return [
		`orchestrator: ${action.orchestratorInstruction}`,
		`launch: ${launch}`,
		`childPrompt:\n${action.childPrompt}`,
		`parentReport: ${action.reportInstruction}`,
	].join("\n");
}

function applyAutoRepairDecision(state: DeliveryState, pending: PendingIssue): boolean {
	if (pending.recommendedDecision !== "repair") return false;
	if (!hasImplementRepairBudget(state)) return false;
	if (pending.source === "verify" && state.verifyRound >= maxRoundsForPhase(state, "VERIFY")) return false;
	if (pending.source === "review" && state.reviewRound >= maxRoundsForPhase(state, "REVIEW")) return false;
	state.pendingIssue = pending;
	state.phase = "IMPLEMENT";
	addHistory(state, {
		phase: "IMPLEMENT",
		event: "auto_repair",
		decision: "repair",
		summary: `Auto-routed ${pending.source} finding back to IMPLEMENT because recommendedDecision=repair`,
		artifact: pending.artifact,
	});
	return true;
}

function transitionAfterReport(state: DeliveryState, params: { phase: Phase; verdict?: Verdict; summary: string; artifact?: string; recommendedDecision?: Decision }) {
	addHistory(state, {
		phase: params.phase,
		event: "report",
		verdict: params.verdict,
		summary: truncate(params.summary),
		artifact: params.artifact,
	});

	if (params.phase === "IMPLEMENT") {
		const repairedIssue = state.pendingIssue;
		state.pendingIssue = undefined;
		if (repairedIssue?.source === "verify") state.verifyRound += 1;
		else if (repairedIssue?.source === "review") {
			state.reviewRound += 1;
			state.verifyRound += 1;
		} else {
			state.verifyRound = Math.max(1, state.verifyRound || 1);
		}
		state.phase = "VERIFY";
		return;
	}

	if (params.phase === "VERIFY") {
		state.lastVerificationVerdict = params.verdict;
		if (isPass(params.verdict)) {
			state.pendingIssue = undefined;
			state.phase = "REVIEW";
			state.reviewRound = Math.max(1, state.reviewRound || 1);
			return;
		}
		const pending: PendingIssue = {
			source: "verify",
			phase: "VERIFY",
			verdict: params.verdict ?? "INCONCLUSIVE",
			summary: params.summary,
			artifact: params.artifact,
			recommendedDecision: params.recommendedDecision ?? (hasImplementRepairBudget(state) && state.verifyRound < maxRoundsForPhase(state, "VERIFY") ? "repair" : "stop"),
		};
		if (params.recommendedDecision === "repair" && applyAutoRepairDecision(state, pending)) return;
		state.pendingIssue = pending;
		state.phase = "WAITING_DECISION";
		return;
	}

	if (params.phase === "REVIEW") {
		state.lastReviewVerdict = params.verdict;
		if (isPass(params.verdict)) {
			state.pendingIssue = undefined;
			state.readyToClose = true;
			state.phase = "CLOSE";
			return;
		}
		const pending: PendingIssue = {
			source: "review",
			phase: "REVIEW",
			verdict: params.verdict ?? "FAIL",
			summary: params.summary,
			artifact: params.artifact,
			recommendedDecision: params.recommendedDecision ?? (hasImplementRepairBudget(state) && state.reviewRound < maxRoundsForPhase(state, "REVIEW") ? "repair" : "stop"),
		};
		if (params.recommendedDecision === "repair" && applyAutoRepairDecision(state, pending)) return;
		state.pendingIssue = pending;
		state.phase = "WAITING_DECISION";
		return;
	}

	if (params.phase === "CLOSE") {
		if (isPass(params.verdict)) {
			state.phase = "RETRO";
			return;
		}
		state.pendingIssue = {
			source: "close",
			phase: "CLOSE",
			verdict: params.verdict ?? "FAIL",
			summary: params.summary,
			artifact: params.artifact,
			recommendedDecision: params.recommendedDecision ?? "stop",
		};
		state.phase = "WAITING_DECISION";
		return;
	}

	if (params.phase === "RETRO") {
		state.phase = "DONE";
		state.active = false;
		return;
	}
}

function applyDecision(state: DeliveryState, decision: Decision, rationale?: string) {
	const pending = state.pendingIssue;
	addHistory(state, {
		phase: state.phase,
		event: "decision",
		decision,
		summary: rationale ?? pending?.summary,
		artifact: pending?.artifact,
	});

	if (!pending) {
		if (decision === "stop") {
			state.phase = "STOPPED";
			state.active = false;
		}
		return;
	}

	if (decision === "stop" || decision === "defer") {
		state.phase = "STOPPED";
		state.active = false;
		return;
	}

	if (decision === "accept_risk") {
		state.acceptedRisks.push(`${pending.source}: ${truncate(pending.summary, 240)}`);
		state.pendingIssue = undefined;
		if (pending.source === "verify") state.phase = "REVIEW";
		else if (pending.source === "review") {
			state.readyToClose = true;
			state.phase = "CLOSE";
		} else state.phase = "RETRO";
		return;
	}

	if (decision === "continue") {
		state.pendingIssue = undefined;
		if (pending.source === "verify") state.phase = "REVIEW";
		else if (pending.source === "review") {
			state.readyToClose = true;
			state.phase = "CLOSE";
		} else state.phase = "RETRO";
		return;
	}

	// repair: route back to IMPLEMENT with the pending issue attached. IMPLEMENT is the only writer phase.
	state.pendingIssue = pending;
	if (pending.source === "verify") {
		if (!hasImplementRepairBudget(state)) {
			state.phase = "STOPPED";
			state.active = false;
			addHistory(state, { phase: "STOPPED", event: "max_implement_rounds", summary: `Reached ${maxRoundsForPhase(state, "IMPLEMENT")} implement repair attempts` });
			return;
		}
		if (state.verifyRound >= maxRoundsForPhase(state, "VERIFY")) {
			state.phase = "STOPPED";
			state.active = false;
			addHistory(state, { phase: "STOPPED", event: "max_verify_rounds", summary: `Reached ${maxRoundsForPhase(state, "VERIFY")} verify repair rounds` });
			return;
		}
		state.phase = "IMPLEMENT";
		return;
	}
	if (pending.source === "review") {
		if (!hasImplementRepairBudget(state)) {
			state.phase = "STOPPED";
			state.active = false;
			addHistory(state, { phase: "STOPPED", event: "max_implement_rounds", summary: `Reached ${maxRoundsForPhase(state, "IMPLEMENT")} implement repair attempts` });
			return;
		}
		if (state.reviewRound >= maxRoundsForPhase(state, "REVIEW")) {
			state.phase = "STOPPED";
			state.active = false;
			addHistory(state, { phase: "STOPPED", event: "max_review_rounds", summary: `Reached ${maxRoundsForPhase(state, "REVIEW")} review repair rounds` });
			return;
		}
		state.phase = "IMPLEMENT";
		return;
	}
	state.phase = "STOPPED";
	state.active = false;
}

function formatPhaseCounts(state: DeliveryState): string[] {
	const reportCounts = new Map<Phase, number>();
	const verdictCounts = new Map<Phase, Map<string, number>>();
	const decisionCounts = new Map<string, number>();
	let starts = 0;
	for (const entry of state.history) {
		if (entry.event === "start") starts += 1;
		if (entry.event === "report") {
			reportCounts.set(entry.phase, (reportCounts.get(entry.phase) ?? 0) + 1);
			if (entry.verdict) {
				const byVerdict = verdictCounts.get(entry.phase) ?? new Map<string, number>();
				byVerdict.set(entry.verdict, (byVerdict.get(entry.verdict) ?? 0) + 1);
				verdictCounts.set(entry.phase, byVerdict);
			}
		}
		if (entry.event === "decision" && entry.decision) decisionCounts.set(entry.decision, (decisionCounts.get(entry.decision) ?? 0) + 1);
	}

	const runnablePhases: Phase[] = ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"];
	const lines = [`starts: ${starts}`, "completed phase reports:"];
	for (const phase of runnablePhases) {
		const count = reportCounts.get(phase) ?? 0;
		if (!count) continue;
		const verdicts = verdictCounts.get(phase);
		const suffix = verdicts?.size
			? ` (${Array.from(verdicts.entries()).map(([verdict, n]) => `${verdict} ${n}`).join(", ")})`
			: "";
		lines.push(`- ${phase}: ${count}${suffix}`);
	}
	if (!Array.from(reportCounts.values()).some(Boolean)) lines.push("- none");
	if (decisionCounts.size) lines.push(`decisions: ${Array.from(decisionCounts.entries()).map(([decision, n]) => `${decision} ${n}`).join(", ")}`);
	return lines;
}

function shouldShowSummary(state: DeliveryState): boolean {
	return state.phase === "DONE" && !state.active;
}

function mdEscape(value: string | undefined): string {
	return (value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function artifactLink(state: DeliveryState, artifact?: string): string {
	if (!artifact) return "";
	const relative = state.artifactDir && path.isAbsolute(artifact) ? path.relative(state.artifactDir, artifact) : artifact;
	const label = path.basename(relative) || relative;
	return `[${mdEscape(label)}](${relative.replace(/ /g, "%20")})`;
}

function costCell(step: DeliveryStep): string {
	if (!step.usageDelta || step.usageAttribution === "unavailable") return "unavailable";
	return `${formatCost(step.usageDelta.cost)} (${step.usageAttribution ?? "best-effort"})`;
}

function usageHasAssistantMessages(usage: UsageTotals | undefined): usage is UsageTotals {
	return !!usage && usage.assistantMessages > 0;
}

function legacyStepsFromHistory(state: DeliveryState): DeliveryStep[] {
	const phaseAttempts = new Map<RunnablePhase, number>();
	return state.history
		.filter((entry): entry is HistoryEntry & { phase: RunnablePhase } => entry.event === "report" && isRunnablePhase(entry.phase))
		.map((entry) => {
			const attempt = (phaseAttempts.get(entry.phase) ?? 0) + 1;
			phaseAttempts.set(entry.phase, attempt);
			return {
				id: `legacy-${entry.phase}-${attempt}`,
				phase: entry.phase,
				attempt,
				status: "reported" as const,
				verdict: entry.verdict,
				summary: entry.summary,
				artifact: entry.artifact,
				startedAt: entry.timestamp,
				endedAt: entry.timestamp,
				usageAttribution: "unavailable" as const,
			};
		});
}

function stepRepresentsReport(step: DeliveryStep): boolean {
	return step.status === "reported" && (step.childIndex === undefined || step.agent === "aggregate");
}

function journeySteps(state: DeliveryState): DeliveryStep[] {
	const reportedStepKeys = new Set(
		state.steps
			.filter(stepRepresentsReport)
			.map((step) => `${step.phase}:${step.attempt}`),
	);
	return [
		...legacyStepsFromHistory(state).filter((step) => !reportedStepKeys.has(`${step.phase}:${step.attempt}`)),
		...state.steps,
	];
}

function readArtifactText(artifact?: string): string | undefined {
	if (!artifact || !fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) return undefined;
	try {
		return fs.readFileSync(artifact, "utf8");
	} catch {
		return undefined;
	}
}

function extractMarkdownSection(markdown: string | undefined, heading: string): string | undefined {
	if (!markdown) return undefined;
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`^##\\s+${escaped}\\s*$`, "im").exec(markdown);
	if (!match) return undefined;
	const tail = markdown.slice(match.index + match[0].length);
	const nextHeading = tail.search(/^##\s+/m);
	return tail.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}

function firstSentence(text: string | undefined): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "See phase summary/artifact.";
	const match = /(.{1,220}?[.!?])\s/.exec(`${normalized} `);
	return match?.[1] ?? truncate(normalized, 220);
}

function repairAfterFailure(steps: DeliveryStep[], failedStep: DeliveryStep): DeliveryStep | undefined {
	return steps.find((step) => step.phase === "IMPLEMENT" && step.startedAt >= (failedStep.endedAt ?? failedStep.startedAt));
}

function deliveryStatus(state: DeliveryState): Phase {
	return state.phase === "DONE" ? "DONE" : state.phase === "STOPPED" ? "STOPPED" : state.active ? state.phase : "IDLE";
}

function reportUsageSnapshot(state: DeliveryState, ctx: ExtensionContext): ReportUsageSnapshot {
	const currentSessionTotals = collectSessionUsage(ctx);
	const sinceDeliveryStart = currentSessionTotals && state.usageAtStart ? subtractUsage(currentSessionTotals, state.usageAtStart) : undefined;
	const usableCurrentSessionTotals = usageHasAssistantMessages(currentSessionTotals) ? currentSessionTotals : undefined;
	const usableSinceDeliveryStart = usageHasAssistantMessages(sinceDeliveryStart) ? sinceDeliveryStart : undefined;
	return {
		currentSessionTotals,
		sinceDeliveryStart,
		usableCurrentSessionTotals,
		usableSinceDeliveryStart,
		attribution: usableCurrentSessionTotals ? "best-effort" : "unavailable",
	};
}

function formatJourneyReport(state: DeliveryState, ctx: ExtensionContext, usageSnapshot = reportUsageSnapshot(state, ctx)): string {
	refreshGitInfo(ctx, state);
	const steps = journeySteps(state);
	steps.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const currentUsage = usageSnapshot.currentSessionTotals;
	const usableCurrentUsage = usageSnapshot.usableCurrentSessionTotals;
	const usableSinceStart = usageSnapshot.usableSinceDeliveryStart;
	const status = deliveryStatus(state);
	const lines: string[] = [
		"# Delivery summary",
		"",
		`Task: ${state.task ?? "<none>"}`,
		`Status: ${status}`,
		`Artifact directory: ${state.artifactDir ?? "<none>"}`,
		`Cwd: ${state.cwd ?? ctx.cwd ?? "<unknown>"}`,
		`Branch: ${state.gitBranch ?? "<not a git worktree>"}`,
		`Overall cost: ${usableSinceStart ? formatCost(usableSinceStart.cost) : "unavailable"}`,
		`Overall tokens: ${usableSinceStart ? formatNumber(usableSinceStart.totalTokens) : "unavailable"}`,
		"Cost attribution: best-effort per step; overall cost is authoritative for discovered session files when usage is available.",
		"",
		"## Journey",
		"",
		"| # | Phase | Agent | Model | Verdict | Cost | Detail |",
		"|---|---|---|---|---|---:|---|",
	];
	if (!steps.length) {
		lines.push("| - | - | - | - | - | unavailable | No phase reports recorded yet. |");
	} else {
		let displayIndex = 1;
		for (const step of steps) {
			const rowNumber = step.childCount && step.childIndex !== undefined
				? `${displayIndex}${String.fromCharCode(97 + step.childIndex)}`
				: String(displayIndex);
			lines.push(`| ${rowNumber} | ${step.phase}${step.attempt > 1 ? ` #${step.attempt}` : ""} | ${mdEscape(step.agent || "unknown")} | ${mdEscape(step.model || "default")} | ${mdEscape(step.verdict || (step.status === "planned" ? "planned" : "unavailable"))} | ${costCell(step)} | ${artifactLink(state, step.artifact) || mdEscape(firstSentence(step.summary))} |`);
			if (!step.childCount || step.childIndex === undefined || step.childIndex === step.childCount - 1) displayIndex += 1;
		}
	}

	lines.push("", "## Failure overview", "", "| Failed step | Why it failed | Repair action | Detail |", "|---|---|---|---|");
	const failures = steps.filter((step) => isFail(step.verdict));
	if (!failures.length) {
		lines.push("| - | No failed verifier/reviewer/close steps recorded. | - | - |");
	} else {
		for (const failure of failures) {
			const artifactText = readArtifactText(failure.artifact);
			const failureReason = firstSentence(extractMarkdownSection(artifactText, "Failure reason") ?? failure.summary);
			const repair = repairAfterFailure(steps, failure);
			const repairAction = repair ? firstSentence(repair.summary) : "No subsequent repair step recorded.";
			lines.push(`| ${failure.phase} #${failure.attempt}${failure.childIndex !== undefined ? ` child ${failure.childIndex + 1}` : ""} | ${mdEscape(failureReason)} | ${mdEscape(repairAction)} | ${artifactLink(state, failure.artifact)} |`);
		}
	}

	const retro = [...steps].reverse().find((step) => step.phase === "RETRO");
	const retroText = readArtifactText(retro?.artifact);
	const criticalFixes = extractMarkdownSection(retroText, "Critical fixes for future plans / delivery");
	lines.push("", "## Critical fixes for future plans / delivery", "");
	if (criticalFixes) lines.push(criticalFixes);
	else if (retro?.artifact) lines.push(`See retro artifact for critical fixes and lessons: ${artifactLink(state, retro.artifact)}`);
	else lines.push("No retro critical-fixes section recorded yet.");

	lines.push("", "## Usage", "");
	if (!currentUsage) {
		lines.push("- Total: unavailable (current session is ephemeral or has no session file)");
		lines.push("- Since `delivery_start`: unavailable");
	} else if (!usageHasAssistantMessages(currentUsage)) {
		lines.push("- Total: unavailable (current session has no usage-bearing assistant messages)");
		lines.push("- Since `delivery_start`: unavailable");
	} else {
		lines.push(`- Total current session + discovered subagents: ${formatNumber(currentUsage.totalTokens)} tokens, ${formatCost(currentUsage.cost)}`);
		lines.push(`- Since \`delivery_start\`: ${usableSinceStart ? `${formatNumber(usableSinceStart.totalTokens)} tokens, ${formatCost(usableSinceStart.cost)}` : "unavailable for deliveries started before usage baseline tracking or without usage-bearing assistant messages"}`);
	}
	lines.push("- Attribution notes:");
	lines.push("  - Sequential phase costs are calculated from usage deltas when available.");
	lines.push("  - Parallel phase child costs are exact only if child session files can be matched to child launches; otherwise rows show phase aggregate or unavailable.");
	lines.push("  - Unavailable means no session usage file/baseline or no usage-bearing assistant messages were available; zero cost is not inferred.");
	lines.push("", "## Phase counts", "", ...formatPhaseCounts(state).map((line) => `- ${line}`));
	return lines.join("\n");
}

function buildStructuredReport(
	state: DeliveryState,
	_ctx: ExtensionContext,
	summaryMarkdownPath: string,
	generatedAt: number,
	usageSnapshot: ReportUsageSnapshot,
): DeliveryReportJsonV1 {
	const plainState = cloneState(state);
	const firstHistoryTimestamp = plainState.history.length
		? Math.min(...plainState.history.map((entry) => entry.timestamp).filter((timestamp) => Number.isFinite(timestamp)))
		: undefined;
	return {
		schemaVersion: 1,
		source: "delivery-state-machine",
		id: path.basename(plainState.artifactDir ?? path.dirname(summaryMarkdownPath)),
		task: plainState.task ?? null,
		status: deliveryStatus(plainState),
		phase: plainState.phase,
		artifactDir: plainState.artifactDir ?? path.dirname(summaryMarkdownPath),
		...(plainState.cwd ? { cwd: plainState.cwd } : {}),
		...(plainState.gitBranch ? { gitBranch: plainState.gitBranch } : {}),
		...(plainState.gitRoot ? { gitRoot: plainState.gitRoot } : {}),
		...(firstHistoryTimestamp !== undefined ? { createdAt: firstHistoryTimestamp } : {}),
		updatedAt: plainState.updatedAt,
		generatedAt,
		summaryMarkdownPath,
		history: plainState.history,
		steps: plainState.steps,
		acceptedRisks: plainState.acceptedRisks,
		pendingIssue: plainState.pendingIssue ?? null,
		usage: {
			currentSessionTotals: usageSnapshot.usableCurrentSessionTotals ?? null,
			sinceDeliveryStart: usageSnapshot.usableSinceDeliveryStart ?? null,
			attribution: usageSnapshot.attribution,
		},
	};
}

function writeJsonAtomic(filePath: string, data: unknown) {
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	fs.renameSync(tmpPath, filePath);
}

function writeReportArtifacts(state: DeliveryState, ctx: ExtensionContext): ReportArtifacts {
	const usageSnapshot = reportUsageSnapshot(state, ctx);
	const markdown = formatJourneyReport(state, ctx, usageSnapshot);
	if (!state.artifactDir) return { markdown };
	fs.mkdirSync(state.artifactDir, { recursive: true });
	const markdownPath = path.join(state.artifactDir, "00-delivery-summary.md");
	const jsonPath = path.join(state.artifactDir, "delivery-report.json");
	fs.writeFileSync(markdownPath, markdown, "utf8");
	try {
		const generatedAt = Date.now();
		writeJsonAtomic(jsonPath, buildStructuredReport(state, ctx, markdownPath, generatedAt, usageSnapshot));
		return { markdownPath, jsonPath, markdown };
	} catch (error) {
		return {
			markdownPath,
			jsonPath,
			markdown,
			jsonWriteError: error instanceof Error ? error.message : String(error),
		};
	}
}

function writeJourneyReport(state: DeliveryState, ctx: ExtensionContext): string | undefined {
	return writeReportArtifacts(state, ctx).markdownPath;
}

function formatDeliverySummary(state: DeliveryState, ctx: ExtensionContext): string {
	const artifacts = writeReportArtifacts(state, ctx);
	if (!artifacts.markdownPath) return artifacts.markdown;
	const jsonLine = artifacts.jsonPath
		? artifacts.jsonWriteError
			? `\nStructured JSON write warning: ${artifacts.jsonWriteError}`
			: `\nStructured JSON written: ${artifacts.jsonPath}`
		: "";
	return `${artifacts.markdown}\n\nReport written: ${artifacts.markdownPath}${jsonLine}`;
}

function formatState(state: DeliveryState): string {
	const lines = [
		statusText(state),
		`task: ${state.task ?? "<none>"}`,
		`rounds: implement ${implementationAttempt(state)}/${maxRoundsForPhase(state, "IMPLEMENT")}, verify ${state.verifyRound}/${maxRoundsForPhase(state, "VERIFY")}, review ${state.reviewRound}/${maxRoundsForPhase(state, "REVIEW")}, close ${maxRoundsForPhase(state, "CLOSE")}, retro ${maxRoundsForPhase(state, "RETRO")}`,
		`readyToClose: ${state.readyToClose}`,
	];
	if (state.cwd) lines.push(`cwd: ${state.cwd}`);
	if (state.gitBranch) lines.push(`gitBranch: ${state.gitBranch}`);
	if (state.gitRoot) lines.push(`gitRoot: ${state.gitRoot}`);
	if (state.artifactDir) lines.push(`artifactDir: ${state.artifactDir}`);
	if (state.pendingIssue) {
		lines.push(`pending ${state.pendingIssue.source}: ${state.pendingIssue.verdict}`);
		lines.push(`pending summary: ${truncate(state.pendingIssue.summary, 300)}`);
		lines.push(`recommended: ${state.pendingIssue.recommendedDecision ?? "<none>"}`);
	}
	if (state.acceptedRisks.length) lines.push(`accepted risks: ${state.acceptedRisks.length}`);
	lines.push(`next:\n${formatNextAction(state)}`);
	return lines.join("\n");
}

function isDangerousCloseCommand(command: string): boolean {
	const normalized = command.replace(/\\\s+/g, " ").trim();
	return (
		/(^|[;&|]\s*)git\s+push(\s|$)/.test(normalized) ||
		/(^|[;&|]\s*)glab\s+mr\s+create(\s|$)/.test(normalized) ||
		/(^|[;&|]\s*)gh\s+pr\s+create(\s|$)/.test(normalized)
	);
}

export default function deliveryStateMachine(pi: ExtensionAPI) {
	let state: DeliveryState = initialState();

	function persist() {
		pi.appendEntry("delivery-state-machine", cloneState(state));
	}

	function reconstruct(ctx: ExtensionContext) {
		state = initialState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "delivery-state-machine") {
				state = normalizeState(entry.data as Partial<DeliveryState>);
			}
			if (entry.type === "message" && entry.message.role === "toolResult") {
				const toolName = entry.message.toolName;
				if (toolName?.startsWith("delivery_")) {
					const details = entry.message.details as { state?: Partial<DeliveryState> } | undefined;
					if (details?.state) state = normalizeState(details.state);
				}
			}
		}
		updateUi(ctx, state);
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: string } | undefined;
		const command = input?.command ?? "";
		if (!state.active || state.readyToClose || state.phase === "CLOSE" || state.phase === "RETRO" || state.phase === "DONE") return;
		if (!isDangerousCloseCommand(command)) return;
		return {
			block: true,
			reason: `delivery-state-machine blocked push/MR command while phase=${state.phase}. Run delivery_next and reach CLOSE with readyToClose=true first.`,
		};
	});

	pi.registerCommand("deliver", {
		description: "Start the delivery state machine: /deliver <task>",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /deliver <task / issue / bug>", "warning");
				return;
			}
			state = initialState();
			state.active = true;
			state.task = task;
			state.maxPhaseRounds = resolveMaxPhaseRounds(loadDeliveryConfig(ctx.cwd));
			state.maxRepairRounds = state.maxPhaseRounds.VERIFY;
			state.artifactDir = createArtifactDir(ctx.cwd, task);
			state.usageAtStart = collectSessionUsage(ctx);
			refreshGitInfo(ctx, state);
			state.phase = "IMPLEMENT";
			state.verifyRound = 1;
			state.reviewRound = 1;
			addHistory(state, { phase: "IMPLEMENT", event: "start", summary: truncate(task) });
			recordPlannedSteps(state, ctx, nextAction(state));
			persist();
			updateUi(ctx, state);
			pi.setSessionName(`deliver: ${truncate(task, 50)}`);
			pi.sendUserMessage(renderDeliverPrompt(state));
		},
	});

	pi.registerCommand("delivery-status", {
		description: "Show delivery state machine status",
		handler: async (_args, ctx) => {
			reconstruct(ctx);
			ctx.ui.notify(shouldShowSummary(state) ? formatDeliverySummary(state, ctx) : formatState(state), "info");
		},
	});

	pi.registerCommand("delivery-summary", {
		description: "Show delivery phase counts and session/subagent usage summary",
		handler: async (_args, ctx) => {
			reconstruct(ctx);
			ctx.ui.notify(formatDeliverySummary(state, ctx), "info");
		},
	});

	pi.registerCommand("delivery-reset", {
		description: "Reset delivery state machine",
		handler: async (_args, ctx) => {
			state = initialState();
			persist();
			updateUi(ctx, state);
			ctx.ui.notify("Delivery state reset", "info");
		},
	});

	pi.registerTool({
		name: "delivery_start",
		label: "Delivery Start",
		description: "Start the delivery state machine for a task.",
		promptSnippet: "Start a controlled implement-verify-review-close-retro delivery workflow",
		promptGuidelines: [
			"Use delivery_start when the user asks to deliver a task through the state-machine workflow.",
			"Before implementation, unless this is the same task or an amended requirement, ensure repo work happens in a dedicated git worktree created from latest main; for non-git/non-repo tasks, record why this is not applicable.",
			"After delivery_start, use delivery_next before launching each subagent and delivery_report after each subagent returns.",
			"Pass only details.next.childPrompt to subagents; parent-only launch/report instructions stay with the orchestrator.",
		],
		parameters: START_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			state = initialState();
			state.active = true;
			state.task = params.task;
			state.maxPhaseRounds = resolveMaxPhaseRounds(loadDeliveryConfig(ctx.cwd), params.maxRepairRounds, params.maxRounds);
			state.maxRepairRounds = state.maxPhaseRounds.VERIFY;
			state.artifactDir = createArtifactDir(ctx.cwd, params.task);
			state.usageAtStart = collectSessionUsage(ctx);
			refreshGitInfo(ctx, state);
			state.phase = "IMPLEMENT";
			state.verifyRound = 1;
			state.reviewRound = 1;
			addHistory(state, { phase: "IMPLEMENT", event: "start", summary: truncate(params.task) });
			const action = nextAction(state);
			recordPlannedSteps(state, ctx, action);
			persist();
			updateUi(ctx, state);
			return { content: [{ type: "text", text: formatState(state) }], details: { state: cloneState(state), next: action } };
		},
	});

	pi.registerTool({
		name: "delivery_next",
		label: "Delivery Next",
		description: "Get the next state-machine action, launch settings, and child prompt.",
		promptSnippet: "Return the next required delivery state-machine action",
		promptGuidelines: [
			"Use delivery_next before launching any delivery workflow subagent.",
			"Launch the returned agent/model/thinking/context and pass only details.next.childPrompt to the subagent.",
			"Keep details.next.orchestratorInstruction and details.next.reportInstruction for the parent/orchestrator.",
			"Follow delivery_next exactly; do not skip verification/review/close gates.",
		],
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			updateUi(ctx, state);
			const action = nextAction(state);
			recordPlannedSteps(state, ctx, action);
			persist();
			const text = shouldShowSummary(state) ? formatDeliverySummary(state, ctx) : formatState(state);
			return { content: [{ type: "text", text }], details: { state: cloneState(state), next: action } };
		},
	});

	pi.registerTool({
		name: "delivery_report",
		label: "Delivery Report",
		description: "Report completion of the current delivery phase and advance the state machine.",
		promptSnippet: "Advance delivery workflow after a subagent result",
		promptGuidelines: [
			"Use delivery_report immediately after each delivery subagent finishes, with verdict and evidence summary.",
			"For VERIFY/REVIEW failures still within the original task or accepted plan, pass recommendedDecision='repair' so the state machine routes back to IMPLEMENT automatically.",
			"Ask the user/parent before repair only when the fix would change scope, conflict with the plan, require product judgment, exceed max rounds, or needs accept-risk/stop/defer.",
		],
		parameters: REPORT_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active && state.phase !== "RETRO") {
				return { content: [{ type: "text", text: "No active delivery. Use delivery_start or /deliver first." }], details: { state: cloneState(state) } };
			}
			recordReportedSteps(state, ctx, params as { phase: Phase; verdict?: Verdict; summary: string; artifact?: string });
			transitionAfterReport(state, params as { phase: Phase; verdict?: Verdict; summary: string; artifact?: string; recommendedDecision?: Decision });
			persist();
			updateUi(ctx, state);
			const text = shouldShowSummary(state) ? formatDeliverySummary(state, ctx) : formatState(state);
			return { content: [{ type: "text", text }], details: { state: cloneState(state), next: nextAction(state) } };
		},
	});

	pi.registerTool({
		name: "delivery_decide",
		label: "Delivery Decide",
		description: "Apply a parent/user decision for a pending verification/review/close issue.",
		promptSnippet: "Record parent decision for pending delivery issue",
		promptGuidelines: [
			"Use delivery_decide only after the parent/user has decided how to handle a pending delivery issue.",
			"Do not choose accept_risk yourself for blockers; require explicit user/parent approval.",
		],
		parameters: DECIDE_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			applyDecision(state, params.decision as Decision, params.rationale);
			persist();
			updateUi(ctx, state);
			return { content: [{ type: "text", text: formatState(state) }], details: { state: cloneState(state), next: nextAction(state) } };
		},
	});

	pi.registerTool({
		name: "delivery_status",
		label: "Delivery Status",
		description: "Show current delivery state-machine status.",
		promptSnippet: "Inspect current delivery workflow state",
		promptGuidelines: ["Use delivery_status when resuming or checking a delivery workflow."],
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			updateUi(ctx, state);
			const text = shouldShowSummary(state) ? formatDeliverySummary(state, ctx) : formatState(state);
			return { content: [{ type: "text", text }], details: { state: cloneState(state), next: nextAction(state) } };
		},
	});

	pi.registerTool({
		name: "delivery_summary",
		label: "Delivery Summary",
		description: "Summarize delivery phase counts and current session/subagent usage.",
		promptSnippet: "Summarize delivery workflow phase counts and usage",
		promptGuidelines: ["Use delivery_summary when the user asks for delivery phase counts, summary report, or overall delivery cost."],
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			updateUi(ctx, state);
			return { content: [{ type: "text", text: formatDeliverySummary(state, ctx) }], details: { state: cloneState(state), usage: collectSessionUsage(ctx) } };
		},
	});

	pi.registerTool({
		name: "delivery_reset",
		label: "Delivery Reset",
		description: "Reset the delivery state machine to idle.",
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			state = initialState();
			persist();
			updateUi(ctx, state);
			return { content: [{ type: "text", text: "Delivery state reset." }], details: { state: cloneState(state) } };
		},
	});
}
