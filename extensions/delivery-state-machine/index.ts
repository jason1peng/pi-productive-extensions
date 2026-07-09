import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectSessionUsage as collectSharedSessionUsage, subtractUsageTotals, type UsageTotals } from "../../shared/session-usage.ts";
import type { DeliveryProjectMetadataV1, DeliveryReportJsonV2, DeliveryReportStep } from "../../shared/delivery-report.ts";
import { loadPhaseConfigBundle, loadPhaseConfigs, type LaunchConfig, type ProfileResolution, type RunnablePhase } from "./phase-config";

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

type PhaseRounds = Record<RunnablePhase, number>;
type UsageAttribution = "exact" | "best-effort" | "phase-aggregate" | "unavailable";
type ProjectMetadata = DeliveryProjectMetadataV1;
type DeliveryStep = DeliveryReportStep;

interface ReportUsageSnapshot {
	currentSessionTotals?: UsageTotals;
	sinceDeliveryStart?: UsageTotals;
	usableCurrentSessionTotals?: UsageTotals;
	usableSinceDeliveryStart?: UsageTotals;
	attribution: UsageAttribution;
}

interface ReportArtifacts {
	markdownPath?: string;
	jsonPath?: string;
	markdown: string;
	jsonWriteError?: string;
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
	phaseLaunches?: Record<RunnablePhase, LaunchConfig[]>;
	launchProfile?: ProfileResolution;
	project?: ProjectMetadata;
	updatedAt: number;
}

interface ChildLaunch extends LaunchConfig {
	childPrompt: string;
	acceptance: false;
	artifact?: string;
	output?: string;
	outputMode?: "file-only";
}

interface NextAction {
	phase: Phase;
	agent?: string;
	model?: string;
	thinking?: string;
	context?: string;
	acceptance?: false;
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

function collectSessionUsage(ctx: ExtensionContext): UsageTotals | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	return sessionFile ? collectSharedSessionUsage(sessionFile).total : undefined;
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

function slugifyPathSegment(value: string, fallback: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || fallback;
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
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

function projectRootForState(cwd: string, gitRoot?: string): string {
	return gitRoot || cwd;
}

function createProjectMetadata(cwd: string, gitRoot?: string): ProjectMetadata {
	const root = projectRootForState(cwd, gitRoot);
	const normalizedRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
	const name = path.basename(normalizedRoot) || "project";
	const projectId = `${slugifyPathSegment(name, "project")}-${shortHash(normalizedRoot)}`;
	const gitRemote = gitRoot ? gitOutput(cwd, ["config", "--get", "remote.origin.url"]) : undefined;
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		projectId,
		name,
		root: normalizedRoot,
		...(gitRoot ? { gitRoot: normalizedRoot } : {}),
		...(gitRemote ? { gitRemote } : {}),
		createdAt: now,
		lastSeenAt: now,
	};
}

function writeProjectMetadata(projectDir: string, metadata: ProjectMetadata) {
	fs.mkdirSync(projectDir, { recursive: true });
	const projectJsonPath = path.join(projectDir, "project.json");
	let existing: ProjectMetadata | undefined;
	if (fs.existsSync(projectJsonPath)) {
		try {
			existing = JSON.parse(fs.readFileSync(projectJsonPath, "utf8")) as ProjectMetadata;
		} catch {
			// Replace malformed project metadata with the current deterministic metadata.
		}
	}
	const written = { ...metadata, createdAt: existing?.createdAt ?? metadata.createdAt, lastSeenAt: metadata.lastSeenAt };
	Object.assign(metadata, written);
	writeJsonAtomic(projectJsonPath, written);
}

function createArtifactDir(cwd: string, task: string, project: ProjectMetadata): string {
	const root = resolveArtifactRoot(cwd, loadDeliveryConfig(cwd));
	const projectDir = path.join(root, "projects", project.projectId);
	writeProjectMetadata(projectDir, project);
	const runsDir = path.join(projectDir, "runs");
	const baseName = `${datePrefix()}-${slugifyTask(task)}`;
	let candidate = path.join(runsDir, baseName);
	let suffix = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(runsDir, `${baseName}-${suffix++}`);
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
	return `\n\nArtifact guidance:\n- User-scope artifact directory for this delivery run: ${state.artifactDir}.\n- Save or report the artifact path under this directory, e.g. 01-implementation.md, 02-verification.md, 03-review.md, 04-close.md, 05-retro.md.\n- Start the artifact with exactly one result line: RESULT: PASS, RESULT: PASS_WITH_NON_BLOCKING_NOTES, RESULT: FAIL, RESULT: INCONCLUSIVE, RESULT: DONE, or RESULT: MR_CREATED.\n- Use the phase-specific headings from the child prompt, in that order, and write \`none\` for empty Findings, Residual risks, or Recommendation sections.\n- Use Markdown bullet lists for checklist/evidence items and fenced code blocks only for short command output snippets. Do not wrap the whole artifact in a code block.\n- Keep the first paragraph of the summary/outcome concise enough for a report card, and put long logs behind artifact links or short fenced snippets.`;
}

function isPass(verdict?: Verdict): boolean {
	return verdict === "PASS" || verdict === "PASS_WITH_NON_BLOCKING_NOTES" || verdict === "DONE" || verdict === "MR_CREATED";
}

function isFail(verdict?: Verdict): boolean {
	return verdict === "FAIL" || verdict === "INCONCLUSIVE";
}

function normalizeVerdict(value: string | undefined): Verdict | undefined {
	const normalized = value?.trim().toUpperCase();
	if (
		normalized === "PASS" ||
		normalized === "PASS_WITH_NON_BLOCKING_NOTES" ||
		normalized === "FAIL" ||
		normalized === "INCONCLUSIVE" ||
		normalized === "DONE" ||
		normalized === "MR_CREATED"
	) return normalized;
	return undefined;
}

function artifactVerdict(artifact?: string): Verdict | undefined {
	if (!artifact || !fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) return undefined;
	try {
		const firstLine = fs.readFileSync(artifact, "utf8").split(/\r?\n/, 1)[0] ?? "";
		return normalizeVerdict(/^RESULT:\s*([A-Z_]+)/i.exec(firstLine)?.[1] ?? /^\s*(PASS_WITH_NON_BLOCKING_NOTES|PASS|FAIL|INCONCLUSIVE|DONE|MR_CREATED)\b/i.exec(firstLine)?.[1]);
	} catch {
		return undefined;
	}
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

function parallelArtifactPathForLaunch(state: DeliveryState, launch: LaunchConfig, index: number): string | undefined {
	if (!isRunnablePhase(state.phase)) return undefined;
	const attempt = phaseAttemptForStep(state, state.phase);
	const artifactName = parallelArtifactName(state.phase, attempt, launch, index);
	return state.artifactDir ? path.join(state.artifactDir, artifactName) : artifactName;
}

function parallelChildPrompt(basePrompt: string, state: DeliveryState, launch: LaunchConfig, index: number, total: number): string {
	if (!isRunnablePhase(state.phase)) return basePrompt;
	const attempt = phaseAttemptForStep(state, state.phase);
	const artifactPath = parallelArtifactPathForLaunch(state, launch, index) ?? parallelArtifactName(state.phase, attempt, launch, index);
	return `${basePrompt}

Parallel phase instruction:
- You are child ${index + 1}/${total} for phase ${state.phase} attempt ${attempt}; work independently from the other parallel child outputs.
- Use or return this unique attempt-specific artifact path for your result: ${artifactPath}.
- Do not write to the generic phase artifact path such as ${PHASE_ARTIFACT_STEMS[state.phase]}.md; the parent/orchestrator may use that for the aggregate phase report.`;
}

function reportInstructionForPhase(phase: RunnablePhase, parallelCount = 1): string {
	const verdictGuidance = phase === "VERIFY" ? " and verdict PASS/FAIL/INCONCLUSIVE" : "";
	if (parallelCount > 1) {
		const aggregateName = PHASE_ARTIFACT_STEMS[phase];
		return `After all ${parallelCount} children complete, parent/orchestrator confirms every details.next.parallel[].artifact file exists, is non-empty, and starts with RESULT/VERDICT. If a child returned inline output or the subagent output was saved elsewhere, copy it to that planned artifact path; if copying is not possible, pass the actual existing child artifact paths in delivery_report.artifact so the state can record existing paths. Then write a clean aggregate phase artifact such as ${aggregateName}.md with links/summaries for each child, and call delivery_report once with phase ${phase}${verdictGuidance}. When child artifacts are at the planned paths, set artifact to only the aggregate artifact path. For REVIEW, report FAIL with recommendedDecision=repair if any reviewer identifies a must-fix finding. delivery_report will reject parallel phase reports when child artifacts are missing or invalid to avoid stale delivery-report.json links.`;
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

	const config = loadPhaseConfigs(state.cwd ?? process.cwd(), state.gitRoot, state.phaseLaunches)[state.phase];
	const context = phasePromptContext(state);
	const childPrompt = `${config.childPrompt(context)}${CHILD_PROMPT_FOOTER}`;
	const launches = config.launches;
	const [primaryLaunch] = launches;
	const parallel = launches.length > 1
		? launches.map((launch, index, allLaunches) => {
			const artifactPath = parallelArtifactPathForLaunch(state, launch, index);
			return {
				...launch,
				acceptance: false as const,
				...(artifactPath ? { artifact: artifactPath, output: artifactPath, outputMode: "file-only" as const } : {}),
				childPrompt: parallelChildPrompt(childPrompt, state, launch, index, allLaunches.length),
			};
		})
		: undefined;
	const orchestratorInstruction = [worktreePolicyInstruction(state), config.orchestratorInstruction(context)].filter(Boolean).join(" ");
	const reportInstruction = reportInstructionForPhase(state.phase, launches.length);
	return {
		phase: state.phase,
		agent: primaryLaunch.agent,
		model: primaryLaunch.model,
		thinking: primaryLaunch.thinking,
		context: primaryLaunch.context,
		acceptance: false,
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
	const fallbackLaunch = loadPhaseConfigs(state.cwd ?? process.cwd(), state.gitRoot, state.phaseLaunches)[phase].launches[0];
	const launches = action.parallel?.length
		? action.parallel
		: [{ agent: action.agent ?? fallbackLaunch.agent, model: action.model, thinking: action.thinking, context: action.context, acceptance: action.acceptance }];
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
	return subtractUsageTotals(usageAfter, step.usageBefore);
}

function usageAttributionForStep(step: DeliveryStep, usageAfter: UsageTotals | undefined, parallel: boolean): UsageAttribution {
	const delta = usageDeltaForStep(step, usageAfter);
	if (!delta || delta.assistantMessages === 0) return "unavailable";
	return parallel ? "phase-aggregate" : "best-effort";
}

function aggregateArtifactPath(state: DeliveryState, phase: RunnablePhase, attempt: number): string | undefined {
	if (!state.artifactDir) return undefined;
	const stem = PHASE_ARTIFACT_STEMS[phase];
	return path.join(state.artifactDir, attempt > 1 ? `${stem}-${attempt}.md` : `${stem}.md`);
}

function splitArtifactRefs(artifact?: string): string[] {
	return (artifact ?? "")
		.split(/[;\n]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function artifactAbsolutePath(state: DeliveryState, artifact: string): string {
	return path.isAbsolute(artifact) ? artifact : path.join(state.artifactDir ?? process.cwd(), artifact);
}

function isSameArtifactPath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

function artifactReadiness(artifact?: string): { ok: true; verdict?: Verdict } | { ok: false; reason: string } {
	if (!artifact) return { ok: false, reason: "missing artifact path" };
	if (!fs.existsSync(artifact)) return { ok: false, reason: "artifact file does not exist" };
	if (!fs.statSync(artifact).isFile()) return { ok: false, reason: "artifact path is not a file" };
	const verdict = artifactVerdict(artifact);
	if (!verdict) return { ok: false, reason: "artifact does not start with RESULT/VERDICT" };
	return { ok: true, verdict };
}

function existingChildArtifactRefs(state: DeliveryState, artifact: string | undefined, aggregatePath: string | undefined): string[] {
	return splitArtifactRefs(artifact)
		.map((ref) => artifactAbsolutePath(state, ref))
		.filter((candidate) => !aggregatePath || !isSameArtifactPath(candidate, aggregatePath))
		.filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function reconcileParallelChildArtifacts(state: DeliveryState, steps: DeliveryStep[], artifact: string | undefined, aggregatePath: string | undefined) {
	const childSteps = steps
		.filter((step) => step.childIndex !== undefined)
		.sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0));
	if (!childSteps.length) return;
	const missingSteps = childSteps.filter((step) => !artifactReadiness(step.artifact).ok);
	if (!missingSteps.length) return;
	const actualRefs = existingChildArtifactRefs(state, artifact, aggregatePath);
	if (actualRefs.length !== childSteps.length) return;
	childSteps.forEach((step, index) => {
		step.artifact = actualRefs[index];
	});
}

function parallelChildArtifactIssues(steps: DeliveryStep[]): string[] {
	return steps
		.filter((step) => step.childIndex !== undefined)
		.map((step) => {
			const readiness = artifactReadiness(step.artifact);
			if (readiness.ok) return undefined;
			const childNumber = (step.childIndex ?? 0) + 1;
			const total = step.childCount ?? steps.length;
			return `${step.phase} #${step.attempt} child ${childNumber}/${total}: ${readiness.reason}${step.artifact ? ` (${step.artifact})` : ""}`;
		})
		.filter((issue): issue is string => Boolean(issue));
}

function markdownLinkForArtifact(state: DeliveryState, artifact: string): string {
	const relative = state.artifactDir && path.isAbsolute(artifact) ? path.relative(state.artifactDir, artifact) : artifact;
	return `[${mdEscape(path.basename(relative) || relative)}](${relative.replace(/ /g, "%20")})`;
}

function aggregateArtifactMarkdown(state: DeliveryState, params: { phase: RunnablePhase; verdict?: Verdict; summary: string }, steps: DeliveryStep[]): string {
	const verdict = params.verdict ?? "INCONCLUSIVE";
	const childLines = steps
		.filter((step) => step.childIndex !== undefined)
		.sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0))
		.map((step) => {
			const childNumber = (step.childIndex ?? 0) + 1;
			const total = step.childCount ?? steps.length;
			const childVerdict = artifactVerdict(step.artifact) ?? step.verdict;
			const agent = [step.agent, step.model].filter(Boolean).join(" / ") || "unknown";
			const link = step.artifact ? markdownLinkForArtifact(state, step.artifact) : "missing artifact";
			return `- Reviewer ${childNumber}/${total} (${agent}): ${childVerdict ?? "artifact verdict unavailable"} — ${link}`;
		})
		.join("\n") || "none";
	if (params.phase === "REVIEW") {
		return `RESULT: ${verdict}\n\n## Summary\n${params.summary}\n\n## Must-fix findings\n${isFail(verdict) ? params.summary : "none"}\n\n## Non-blocking notes\n${verdict === "PASS_WITH_NON_BLOCKING_NOTES" ? params.summary : "none"}\n\n## Evidence reviewed\n${childLines}\n\n## Risk checks\n- Aggregate review verdict derived from preserved parallel reviewer artifacts.\n\n## Recommendation\n${isFail(verdict) ? "repair" : "none"}\n`;
	}
	return `RESULT: ${verdict}\n\n## Summary\n${params.summary}\n\n## Evidence\n${childLines}\n\n## Recommendation\n${isFail(verdict) ? "repair" : "none"}\n`;
}

function ensureAggregateArtifactForParallelReport(state: DeliveryState, params: { phase: RunnablePhase; verdict?: Verdict; summary: string; artifact?: string }, steps: DeliveryStep[]): string | undefined {
	const aggregatePath = aggregateArtifactPath(state, params.phase, steps[0]?.attempt ?? phaseAttemptForStep(state, params.phase));
	if (!aggregatePath) return params.artifact;
	const refs = splitArtifactRefs(params.artifact);
	if (refs.length === 1) {
		const candidate = path.isAbsolute(refs[0]!) ? refs[0]! : path.join(state.artifactDir!, refs[0]!);
		if (isSameArtifactPath(candidate, aggregatePath) && fs.existsSync(candidate)) return candidate;
	}
	if (fs.existsSync(aggregatePath)) return aggregatePath;
	fs.writeFileSync(aggregatePath, aggregateArtifactMarkdown(state, params, steps), "utf8");
	return aggregatePath;
}

function recordReportedSteps(state: DeliveryState, ctx: ExtensionContext, params: { phase: Phase; verdict?: Verdict; summary: string; artifact?: string }): string | undefined {
	if (!isRunnablePhase(params.phase)) return params.artifact;
	const steps = ensurePlannedStepsForReport(state, ctx, params.phase);
	const usageAfter = collectSessionUsage(ctx);
	const parallel = steps.length > 1;
	const aggregatePath = parallel ? aggregateArtifactPath(state, params.phase, steps[0]?.attempt ?? phaseAttemptForStep(state, params.phase)) : undefined;
	if (parallel) {
		reconcileParallelChildArtifacts(state, steps, params.artifact, aggregatePath);
		const childArtifactIssues = parallelChildArtifactIssues(steps);
		if (childArtifactIssues.length) {
			throw new Error(`Cannot report ${params.phase}: parallel child artifacts are missing or invalid. Save each child output to details.next.parallel[].artifact or pass actual existing child artifact paths in artifact before reporting. Issues: ${childArtifactIssues.join("; ")}`);
		}
	}
	const reportArtifact = parallel ? ensureAggregateArtifactForParallelReport(state, { ...params, phase: params.phase }, steps) : params.artifact;
	const endedAt = Date.now();
	for (const step of steps) {
		step.status = "reported";
		step.verdict = parallel ? artifactVerdict(step.artifact) : params.verdict;
		step.summary = parallel ? undefined : truncate(params.summary, 800);
		if (reportArtifact && steps.length === 1) step.artifact = reportArtifact;
		step.endedAt = endedAt;
		step.usageAfter = usageAfter;
		step.usageAttribution = usageAttributionForStep(step, usageAfter, parallel);
		if (usageAfter && step.usageBefore && step.usageAttribution !== "unavailable") {
			step.usageDelta = subtractUsageTotals(usageAfter, step.usageBefore);
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
		if (reportArtifact) aggregate.artifact = reportArtifact;
		aggregate.endedAt = endedAt;
		aggregate.usageAfter = usageAfter;
		aggregate.usageAttribution = usageAttributionForStep(aggregate, usageAfter, true);
		if (usageAfter && aggregate.usageBefore && aggregate.usageAttribution !== "unavailable") {
			aggregate.usageDelta = subtractUsageTotals(usageAfter, aggregate.usageBefore);
		}
		if (!existing) state.steps.push(aggregate);
	}
	state.updatedAt = Date.now();
	return reportArtifact;
}

function formatNextAction(state: DeliveryState): string {
	const action = nextAction(state);
	if (!isRunnablePhase(state.phase)) return action.orchestratorInstruction;
	const launchOne = (launch: { agent?: string; model?: string; thinking?: string; context?: string; acceptance?: false }) => [
		`agent=${launch.agent}`,
		launch.model ? `model=${launch.model}` : undefined,
		launch.thinking ? `thinking=${launch.thinking}` : undefined,
		launch.context ? `context=${launch.context}` : undefined,
		launch.acceptance === false ? "acceptance=false" : undefined,
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

function tokenUsageCell(step: DeliveryStep): string {
	if (!step.usageDelta || step.usageAttribution === "unavailable") return "unavailable";
	return `${formatNumber(step.usageDelta.totalTokens)} tokens (${step.usageAttribution ?? "best-effort"})`;
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
	const sinceDeliveryStart = currentSessionTotals && state.usageAtStart ? subtractUsageTotals(currentSessionTotals, state.usageAtStart) : undefined;
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
	const groupStartedAt = (step: DeliveryStep) => Math.min(
		...steps
			.filter((candidate) => candidate.phase === step.phase && candidate.attempt === step.attempt)
			.map((candidate) => candidate.startedAt),
	);
	const groupRank = (step: DeliveryStep) => step.childIndex ?? (step.agent === "aggregate" ? Number.MAX_SAFE_INTEGER : 0);
	steps.sort((a, b) => {
		const groupOrder = groupStartedAt(a) - groupStartedAt(b);
		if (groupOrder !== 0) return groupOrder;
		const sameGroup = a.phase === b.phase && a.attempt === b.attempt;
		if (sameGroup) return groupRank(a) - groupRank(b) || a.startedAt - b.startedAt || a.id.localeCompare(b.id);
		return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
	});
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
		`Overall input tokens: ${usableSinceStart ? formatNumber(usableSinceStart.input) : "unavailable"}`,
		`Overall output tokens: ${usableSinceStart ? formatNumber(usableSinceStart.output) : "unavailable"}`,
		`Overall cache read tokens: ${usableSinceStart ? formatNumber(usableSinceStart.cacheRead) : "unavailable"}`,
		`Overall cache write tokens: ${usableSinceStart ? formatNumber(usableSinceStart.cacheWrite) : "unavailable"}`,
		"Usage attribution: phase token deltas are best-effort; total cost is reported only from discovered session usage when available.",
		"",
		"## Journey",
		"",
		"| # | Phase | Agent | Model | Verdict | Token usage | Detail |",
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
			lines.push(`| ${rowNumber} | ${step.phase}${step.attempt > 1 ? ` #${step.attempt}` : ""} | ${mdEscape(step.agent || "unknown")} | ${mdEscape(step.model || "default")} | ${mdEscape(step.verdict || (step.status === "planned" ? "planned" : "unavailable"))} | ${tokenUsageCell(step)} | ${artifactLink(state, step.artifact) || mdEscape(firstSentence(step.summary))} |`);
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
		lines.push(`- Total current session + discovered subagents: ${formatUsage(currentUsage)}`);
		lines.push(`- Since \`delivery_start\`: ${usableSinceStart ? formatUsage(usableSinceStart) : "unavailable for deliveries started before usage baseline tracking or without usage-bearing assistant messages"}`);
	}
	lines.push("- Attribution notes:");
	lines.push("  - Sequential phase token usage is calculated from usage deltas when available.");
	lines.push("  - Parallel phase child token usage is exact only if child session files can be matched to child launches; otherwise rows show phase aggregate or unavailable.");
	lines.push("  - Cached input is visible only when session usage records include cache read/write fields.");
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
): DeliveryReportJsonV2 {
	const plainState = cloneState(state);
	const firstHistoryTimestamp = plainState.history.length
		? Math.min(...plainState.history.map((entry) => entry.timestamp).filter((timestamp) => Number.isFinite(timestamp)))
		: undefined;
	return {
		schemaVersion: 2,
		source: "delivery-state-machine",
		id: path.basename(plainState.artifactDir ?? path.dirname(summaryMarkdownPath)),
		task: plainState.task ?? null,
		status: deliveryStatus(plainState),
		phase: plainState.phase,
		artifactDir: plainState.artifactDir ?? path.dirname(summaryMarkdownPath),
		...(plainState.cwd ? { cwd: plainState.cwd } : {}),
		...(plainState.gitBranch ? { gitBranch: plainState.gitBranch } : {}),
		...(plainState.gitRoot ? { gitRoot: plainState.gitRoot } : {}),
		...(plainState.project ? { project: plainState.project } : {}),
		...(plainState.launchProfile ? { launchProfile: plainState.launchProfile } : {}),
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
			const phaseConfigBundle = loadPhaseConfigBundle();
			state.phaseLaunches = phaseConfigBundle.launches;
			state.launchProfile = phaseConfigBundle.profileResolution;
			refreshGitInfo(ctx, state);
			state.project = createProjectMetadata(ctx.cwd, state.gitRoot);
			state.artifactDir = createArtifactDir(ctx.cwd, task, state.project);
			state.usageAtStart = collectSessionUsage(ctx);
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
			"When launching delivery subagents, pass details.next.acceptance/details.next.parallel[].acceptance when present; delivery owns artifact/verdict gates and disables pi-subagents acceptance.",
		],
		parameters: START_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			state = initialState();
			state.active = true;
			state.task = params.task;
			state.maxPhaseRounds = resolveMaxPhaseRounds(loadDeliveryConfig(ctx.cwd), params.maxRepairRounds, params.maxRounds);
			state.maxRepairRounds = state.maxPhaseRounds.VERIFY;
			const phaseConfigBundle = loadPhaseConfigBundle();
			state.phaseLaunches = phaseConfigBundle.launches;
			state.launchProfile = phaseConfigBundle.profileResolution;
			refreshGitInfo(ctx, state);
			state.project = createProjectMetadata(ctx.cwd, state.gitRoot);
			state.artifactDir = createArtifactDir(ctx.cwd, params.task, state.project);
			state.usageAtStart = collectSessionUsage(ctx);
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
			"Launch the returned agent/model/thinking/context and pass only details.next.childPrompt to the subagent for single-child phases.",
			"For parallel phases, pass each details.next.parallel[] entry's childPrompt plus output/outputMode when supported so each child artifact is saved to the planned path.",
			"Pass details.next.acceptance or details.next.parallel[].acceptance when present so pi-subagents acceptance is disabled for delivery-managed artifact contracts.",
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
			const reportParams = { ...(params as { phase: Phase; verdict?: Verdict; summary: string; artifact?: string; recommendedDecision?: Decision }) };
			reportParams.artifact = recordReportedSteps(state, ctx, reportParams) ?? reportParams.artifact;
			transitionAfterReport(state, reportParams);
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
