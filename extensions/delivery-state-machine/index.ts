import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PHASE_CONFIG, type LaunchConfig, type RunnablePhase } from "./phase-config";

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
	return phase in PHASE_CONFIG;
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

function parallelChildPrompt(basePrompt: string, state: DeliveryState, launch: LaunchConfig, index: number, total: number): string {
	if (!isRunnablePhase(state.phase)) return basePrompt;
	const childNumber = String(index + 1).padStart(2, "0");
	const artifactName = `${PHASE_ARTIFACT_STEMS[state.phase]}-${childNumber}-${slugifyLaunch(launch)}.md`;
	const artifactPath = state.artifactDir ? path.join(state.artifactDir, artifactName) : artifactName;
	return `${basePrompt}

Parallel phase instruction:
- You are child ${index + 1}/${total} for phase ${state.phase}; work independently from the other parallel child outputs.
- Use or return this unique artifact path for your result: ${artifactPath}.
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

	const config = PHASE_CONFIG[state.phase];
	const context = phasePromptContext(state);
	const childPrompt = `${config.childPrompt(context)}${CHILD_PROMPT_FOOTER}`;
	const parallelLaunches = config.parallel?.length ? config.parallel : undefined;
	const parallel = parallelLaunches?.map((launch, index, launches) => ({
		...launch,
		childPrompt: parallelChildPrompt(childPrompt, state, launch, index, launches.length),
	}));
	const orchestratorInstruction = [worktreePolicyInstruction(state), config.orchestratorInstruction(context)].filter(Boolean).join(" ");
	const reportInstruction = reportInstructionForPhase(state.phase, parallel?.length ?? 1);
	return {
		phase: state.phase,
		agent: config.agent,
		model: config.model,
		thinking: config.thinking,
		context: config.context,
		parallel,
		prompt: childPrompt,
		childPrompt,
		orchestratorInstruction,
		reportInstruction,
	};
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

function formatDeliverySummary(state: DeliveryState, ctx: ExtensionContext): string {
	const lines = [
		"Delivery summary",
		statusText(state),
		`task: ${state.task ?? "<none>"}`,
		`cwd: ${state.cwd ?? "<unknown>"}`,
		`gitBranch: ${state.gitBranch ?? "<not a git worktree>"}`,
		`artifactDir: ${state.artifactDir ?? "<none>"}`,
		"",
		"Phase counts:",
		...formatPhaseCounts(state),
	];
	const currentUsage = collectSessionUsage(ctx);
	lines.push("", "Usage:");
	if (!currentUsage) {
		lines.push("- unavailable: current session is ephemeral or has no session file");
	} else {
		lines.push(`- current session including subagent session files: ${formatUsage(currentUsage)}`);
		if (state.usageAtStart) {
			lines.push(`- since delivery_start: ${formatUsage(subtractUsage(currentUsage, state.usageAtStart))}`);
		} else {
			lines.push("- since delivery_start: unavailable for deliveries started before usage baseline tracking");
		}
		lines.push("- note: usage is session-level/subagent-level; it is not allocated to individual phases yet.");
	}
	return lines.join("\n");
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
			state.phase = "IMPLEMENT";
			state.verifyRound = 1;
			state.reviewRound = 1;
			addHistory(state, { phase: "IMPLEMENT", event: "start", summary: truncate(task) });
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
			state.phase = "IMPLEMENT";
			state.verifyRound = 1;
			state.reviewRound = 1;
			addHistory(state, { phase: "IMPLEMENT", event: "start", summary: truncate(params.task) });
			persist();
			updateUi(ctx, state);
			return { content: [{ type: "text", text: formatState(state) }], details: { state: cloneState(state), next: nextAction(state) } };
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
			const text = shouldShowSummary(state) ? formatDeliverySummary(state, ctx) : formatState(state);
			return { content: [{ type: "text", text }], details: { state: cloneState(state), next: nextAction(state) } };
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
