import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type RunnablePhase =
	| "IMPLEMENT"
	| "VERIFY"
	| "REVIEW"
	| "CLOSE"
	| "RETRO";

export interface PhasePromptContext {
	task: string;
	artifactGuidance: string;
	verifyRound: number;
	maxRepairRounds: number;
	pendingIssueSummary?: string;
	pendingIssueInstruction: string;
}

export interface LaunchConfig {
	agent: string;
	model?: string;
	thinking?: "low" | "medium" | "high";
	context?: "fresh" | "fork";
}

export interface ConfigurableLaunchConfig {
	agent?: string;
	model?: string | null;
	thinking?: "low" | "medium" | "high";
	context?: "fresh" | "fork";
}

export interface ConfigurablePhaseLaunch extends ConfigurableLaunchConfig {
	parallel?: ConfigurableLaunchConfig[];
}

export interface PhaseConfig extends LaunchConfig {
	parallel?: LaunchConfig[];
	orchestratorInstruction: (context: PhasePromptContext) => string;
	childPrompt: (context: PhasePromptContext) => string;
}

interface PhasePromptTemplates {
	orchestratorInstruction: string;
	childPrompt: string;
}

export const RUNNABLE_PHASES: RunnablePhase[] = ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"];

const PHASE_FILES: Record<RunnablePhase, string> = {
	IMPLEMENT: "implement.md",
	VERIFY: "verify.md",
	REVIEW: "review.md",
	CLOSE: "close.md",
	RETRO: "retro.md",
};

const VALID_THINKING = new Set(["low", "medium", "high"]);
const VALID_CONTEXT = new Set(["fresh", "fork"]);

export const BUILTIN_PHASE_LAUNCH_CONFIG: Record<RunnablePhase, ConfigurablePhaseLaunch> = {
	IMPLEMENT: { agent: "worker" },
	VERIFY: { agent: "fresh-verifier", thinking: "low", context: "fresh" },
	REVIEW: {
		agent: "reviewer",
		parallel: [
			{ agent: "reviewer" },
			{ agent: "reviewer" },
		],
	},
	CLOSE: { agent: "delegate", thinking: "low" },
	RETRO: { agent: "delegate", thinking: "high" },
};

function extensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function phasesDir(): string {
	return path.join(extensionDir(), "phases");
}

export function assertPromptOnly(markdown: string, filename: string) {
	if (!markdown.startsWith("---")) return;
	throw new Error(`Phase prompt ${filename} must be prompt-only markdown. Move agent/model/thinking/context/parallel runtime settings into delivery-state-machine.json.`);
}

function section(markdown: string, heading: string, filename: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`^##\\s+${escaped}\\s*$`, "im").exec(markdown);
	if (!match) throw new Error(`Phase prompt ${filename} is missing section: ## ${heading}`);
	const tail = markdown.slice(match.index + match[0].length);
	const nextHeading = tail.search(/^##\s+/m);
	return tail.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}

function render(template: string, context: PhasePromptContext): string {
	const values = context as unknown as Record<string, string | number | undefined>;
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => String(values[key] ?? ""));
}

function readPhasePrompt(filename: string): PhasePromptTemplates {
	const filePath = path.join(phasesDir(), filename);
	const markdown = fs.readFileSync(filePath, "utf8");
	assertPromptOnly(markdown, filename);
	return {
		orchestratorInstruction: section(markdown, "Orchestrator instruction", filename),
		childPrompt: section(markdown, "Child prompt", filename),
	};
}

function loadPhasePrompts(): Record<RunnablePhase, PhasePromptTemplates> {
	return Object.fromEntries(
		(Object.entries(PHASE_FILES) as Array<[RunnablePhase, string]>).map(([phase, filename]) => [phase, readPhasePrompt(filename)]),
	) as Record<RunnablePhase, PhasePromptTemplates>;
}

const PHASE_PROMPTS: Record<RunnablePhase, PhasePromptTemplates> = loadPhasePrompts();

export function validateConfigurableLaunch(config: ConfigurableLaunchConfig, filename: string, label: string, requireAgent = false) {
	if (requireAgent && !config.agent) throw new Error(`Phase config ${filename} has ${label} without required agent.`);
	if (config.agent !== undefined && typeof config.agent !== "string") throw new Error(`Phase config ${filename} has invalid ${label}.agent; expected string.`);
	if (config.model !== undefined && config.model !== null && typeof config.model !== "string") throw new Error(`Phase config ${filename} has invalid ${label}.model; expected string or null.`);
	if (config.thinking && !VALID_THINKING.has(config.thinking)) throw new Error(`Phase config ${filename} has invalid ${label}.thinking=${config.thinking}.`);
	if (config.context && !VALID_CONTEXT.has(config.context)) throw new Error(`Phase config ${filename} has invalid ${label}.context=${config.context}.`);
}

export function validateConfigurablePhaseLaunch(config: ConfigurablePhaseLaunch, filename: string, label: string) {
	validateConfigurableLaunch(config, filename, label);
	if (config.parallel !== undefined) {
		if (!Array.isArray(config.parallel)) throw new Error(`Phase config ${filename} has invalid ${label}.parallel; expected array.`);
		config.parallel.forEach((launch, index) => validateConfigurableLaunch(launch, filename, `${label}.parallel[${index}]`, true));
	}
}

function materializeLaunch(config: ConfigurableLaunchConfig, filename: string, label: string): LaunchConfig {
	validateConfigurableLaunch(config, filename, label, true);
	const launch: LaunchConfig = { agent: config.agent as string };
	if (typeof config.model === "string") launch.model = config.model;
	if (config.thinking) launch.thinking = config.thinking;
	if (config.context) launch.context = config.context;
	return launch;
}

export function materializePhaseConfig(phase: RunnablePhase, launchConfig: ConfigurablePhaseLaunch): PhaseConfig {
	validateConfigurablePhaseLaunch(launchConfig, "resolved phases", phase);
	const prompt = PHASE_PROMPTS[phase];
	const primary = materializeLaunch(launchConfig, "resolved phases", phase);
	const parallel = launchConfig.parallel?.length
		? launchConfig.parallel.map((launch, index) => materializeLaunch(launch, "resolved phases", `${phase}.parallel[${index}]`))
		: undefined;
	return {
		...primary,
		parallel,
		orchestratorInstruction: (context) => render(prompt.orchestratorInstruction, context),
		childPrompt: (context) => render(prompt.childPrompt, context),
	};
}
