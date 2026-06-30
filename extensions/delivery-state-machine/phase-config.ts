import * as fs from "node:fs";
import * as os from "node:os";
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

export interface PhaseConfig {
	launches: LaunchConfig[];
	orchestratorInstruction: (context: PhasePromptContext) => string;
	childPrompt: (context: PhasePromptContext) => string;
}

interface PromptConfig {
	orchestratorInstruction?: string;
	childPrompt?: string;
}

const PHASE_FILES: Record<RunnablePhase, string> = {
	IMPLEMENT: "implement.md",
	VERIFY: "verify.md",
	REVIEW: "review.md",
	CLOSE: "close.md",
	RETRO: "retro.md",
};

const PHASE_LAUNCHES_FILE = "phase-launches.json";
const PROMPT_FRONTMATTER_KEYS = new Set(["phase"]);
const LAUNCH_KEYS = new Set(["agent", "model", "thinking", "context"]);
const VALID_THINKING = new Set(["low", "medium", "high"]);
const VALID_CONTEXT = new Set(["fresh", "fork"]);

function extensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function builtinPhasesDir(): string {
	return path.join(extensionDir(), "phases");
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, os.homedir()) ?? path.join(os.homedir(), ".pi", "agent");
}

function userConfigDir(): string {
	return path.join(agentDir(), "extensions", "delivery-state-machine");
}

function projectConfigDir(cwd: string, projectRoot?: string): string {
	return path.join(projectRoot || cwd, ".pi", "delivery-state-machine");
}

function parseFrontmatter(markdown: string, filename: string): { data: Record<string, string>; body: string } {
	if (!markdown.startsWith("---\n")) return { data: {}, body: markdown };
	const end = markdown.indexOf("\n---", 4);
	if (end === -1) throw new Error(`Phase config ${filename} has unterminated frontmatter.`);
	const frontmatter = markdown.slice(4, end);
	const body = markdown.slice(end + "\n---".length).replace(/^\r?\n/, "");
	const data: Record<string, string> = {};
	for (const line of frontmatter.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator === -1) throw new Error(`Phase config ${filename} has invalid frontmatter line: ${line}`);
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim().replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "");
		data[key] = value;
	}
	return { data, body };
}

function optionalSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`^##\\s+${escaped}\\s*$`, "im").exec(markdown);
	if (!match) return undefined;
	const tail = markdown.slice(match.index + match[0].length);
	const nextHeading = tail.search(/^##\s+/m);
	return tail.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}

function render(template: string, context: PhasePromptContext): string {
	const values = context as unknown as Record<string, string | number | undefined>;
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => String(values[key] ?? ""));
}

function validatePromptFrontmatter(data: Record<string, string>, filename: string) {
	for (const key of Object.keys(data)) {
		if (!PROMPT_FRONTMATTER_KEYS.has(key)) throw new Error(`Phase config ${filename} must not declare ${key}; launch settings belong in ${PHASE_LAUNCHES_FILE}.`);
	}
}

function readPromptConfig(phase: RunnablePhase, filePath: string): PromptConfig | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const filename = path.relative(extensionDir(), filePath).replace(/^\.\.\//, filePath);
	const markdown = fs.readFileSync(filePath, "utf8");
	const { data, body } = parseFrontmatter(markdown, filename);
	validatePromptFrontmatter(data, filename);
	if (data.phase && data.phase !== phase) throw new Error(`Phase config ${filename} declares phase=${data.phase}, expected ${phase}.`);
	return {
		orchestratorInstruction: optionalSection(body, "Orchestrator instruction"),
		childPrompt: optionalSection(body, "Child prompt"),
	};
}

function mergePromptConfig(base: PromptConfig, override?: PromptConfig): PromptConfig {
	if (!override) return base;
	return {
		orchestratorInstruction: override.orchestratorInstruction ?? base.orchestratorInstruction,
		childPrompt: override.childPrompt ?? base.childPrompt,
	};
}

function promptConfigForPhase(phase: RunnablePhase, cwd: string, projectRoot?: string): Required<PromptConfig> {
	const filename = PHASE_FILES[phase];
	let config: PromptConfig = {};
	for (const dir of [builtinPhasesDir(), path.join(userConfigDir(), "phases"), path.join(projectConfigDir(cwd, projectRoot), "phases")]) {
		config = mergePromptConfig(config, readPromptConfig(phase, path.join(dir, filename)));
	}
	if (!config.orchestratorInstruction) throw new Error(`Phase config ${filename} is missing section: ## Orchestrator instruction`);
	if (!config.childPrompt) throw new Error(`Phase config ${filename} is missing section: ## Child prompt`);
	return config as Required<PromptConfig>;
}

function validateLaunchConfig(config: unknown, filename: string, label: string): LaunchConfig {
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Launch config ${filename} has invalid ${label}; expected object.`);
	const raw = config as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!LAUNCH_KEYS.has(key)) throw new Error(`Launch config ${filename} has invalid ${label}.${key}; expected one of agent, model, thinking, context.`);
	}
	if (typeof raw.agent !== "string" || !raw.agent.trim()) throw new Error(`Launch config ${filename} has ${label} without required agent.`);
	const launch: LaunchConfig = { agent: raw.agent.trim() };
	if (raw.model !== undefined) {
		if (typeof raw.model !== "string" || !raw.model.trim()) throw new Error(`Launch config ${filename} has invalid ${label}.model.`);
		launch.model = raw.model.trim();
	}
	if (raw.thinking !== undefined) {
		if (typeof raw.thinking !== "string" || !VALID_THINKING.has(raw.thinking)) throw new Error(`Launch config ${filename} has invalid ${label}.thinking=${String(raw.thinking)}.`);
		launch.thinking = raw.thinking as LaunchConfig["thinking"];
	}
	if (raw.context !== undefined) {
		if (typeof raw.context !== "string" || !VALID_CONTEXT.has(raw.context)) throw new Error(`Launch config ${filename} has invalid ${label}.context=${String(raw.context)}.`);
		launch.context = raw.context as LaunchConfig["context"];
	}
	return launch;
}

function validateLaunches(value: unknown, filename: string, phase: RunnablePhase): LaunchConfig[] {
	const values = Array.isArray(value) ? value : [value];
	if (!values.length) throw new Error(`Launch config ${filename} phase ${phase} must include at least one launch.`);
	return values.map((launch, index) => validateLaunchConfig(launch, filename, `${phase}[${index}]`));
}

function readLaunchConfig(filePath: string): Partial<Record<RunnablePhase, LaunchConfig[]>> {
	if (!fs.existsSync(filePath)) return {};
	const filename = path.relative(extensionDir(), filePath).replace(/^\.\.\//, filePath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Launch config ${filename} is invalid JSON: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Launch config ${filename} must be an object keyed by phase.`);
	const config: Partial<Record<RunnablePhase, LaunchConfig[]>> = {};
	for (const [phase, launches] of Object.entries(parsed as Record<string, unknown>)) {
		if (!(phase in PHASE_FILES)) throw new Error(`Launch config ${filename} has unknown phase: ${phase}`);
		config[phase as RunnablePhase] = validateLaunches(launches, filename, phase as RunnablePhase);
	}
	return config;
}

function mergeLaunchConfigs(base: Partial<Record<RunnablePhase, LaunchConfig[]>>, override: Partial<Record<RunnablePhase, LaunchConfig[]>>): Partial<Record<RunnablePhase, LaunchConfig[]>> {
	return { ...base, ...override };
}

function loadLaunchConfigs(cwd: string, projectRoot?: string): Record<RunnablePhase, LaunchConfig[]> {
	let config: Partial<Record<RunnablePhase, LaunchConfig[]>> = {};
	for (const filePath of [
		path.join(extensionDir(), PHASE_LAUNCHES_FILE),
		path.join(userConfigDir(), PHASE_LAUNCHES_FILE),
		path.join(projectConfigDir(cwd, projectRoot), PHASE_LAUNCHES_FILE),
	]) {
		config = mergeLaunchConfigs(config, readLaunchConfig(filePath));
	}
	for (const phase of Object.keys(PHASE_FILES) as RunnablePhase[]) {
		if (!config[phase]?.length) throw new Error(`Launch config is missing required phase: ${phase}`);
	}
	return config as Record<RunnablePhase, LaunchConfig[]>;
}

function materializeConfig(prompt: Required<PromptConfig>, launches: LaunchConfig[]): PhaseConfig {
	return {
		launches,
		orchestratorInstruction: (context) => render(prompt.orchestratorInstruction, context),
		childPrompt: (context) => render(prompt.childPrompt, context),
	};
}

export function loadPhaseConfigs(cwd = process.cwd(), projectRoot?: string): Record<RunnablePhase, PhaseConfig> {
	const launchConfig = loadLaunchConfigs(cwd, projectRoot);
	return Object.fromEntries(
		(Object.keys(PHASE_FILES) as RunnablePhase[]).map((phase) => [phase, materializeConfig(promptConfigForPhase(phase, cwd, projectRoot), launchConfig[phase])]),
	) as Record<RunnablePhase, PhaseConfig>;
}

export const PHASE_CONFIG: Record<RunnablePhase, PhaseConfig> = loadPhaseConfigs();
