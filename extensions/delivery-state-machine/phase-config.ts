import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DELIVERY_PHASES, profileConfigFromRaw, readActiveProfilePayload, selectDeliveryProfile, type DeliveryProfileDefinitionSource, type DeliveryProfileSelectionSource } from "../../shared/delivery-profile-config.ts";
import { PHASE_CONTRACTS, phaseArtifactContractMarkdown, type RunnablePhase } from "./phase-contract.ts";

export type { RunnablePhase } from "./phase-contract.ts";

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

export interface ProfileResolution {
	selectedProfile: string;
	source: DeliveryProfileSelectionSource;
	definitionSource: DeliveryProfileDefinitionSource;
	envOverride: boolean;
}

export interface PhaseConfig {
	launches: LaunchConfig[];
	orchestratorInstruction: (context: PhasePromptContext) => string;
	childPrompt: (context: PhasePromptContext) => string;
}

export interface PhaseConfigBundle {
	phases: Record<RunnablePhase, PhaseConfig>;
	launches: Record<RunnablePhase, LaunchConfig[]>;
	profileResolution: ProfileResolution;
}

interface PromptConfig {
	orchestratorInstruction?: string;
	childPrompt?: string;
}

interface ProfileLaunchConfig {
	defaultProfile?: string;
	profiles: Record<string, Record<RunnablePhase, LaunchConfig[]>>;
}

const PHASE_FILES: Record<RunnablePhase, string> = {
	IMPLEMENT: "implement.md",
	VERIFY: "verify.md",
	REVIEW: "review.md",
	CLOSE: "close.md",
	RETRO: "retro.md",
};

const PHASE_LAUNCHES_FILE = "phase-launches.json";
const ACTIVE_PROFILE_FILE = "active-profile.json";
const PROMPT_FRONTMATTER_KEYS = new Set(["phase"]);
const LAUNCH_KEYS = new Set(["agent", "model", "thinking", "context"]);
const PROFILE_KEYS = new Set(["defaultProfile", "profiles"]);
const VALID_THINKING = new Set(["low", "medium", "high"]);
const VALID_CONTEXT = new Set(["fresh", "fork"]);

function extensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function builtinPhasesDir(): string {
	return path.join(extensionDir(), "phases");
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, os.homedir()) ?? path.join(os.homedir(), ".pi", "agent");
}

export function userConfigDir(): string {
	return path.join(agentDir(), "extensions", "delivery-state-machine");
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

function promptConfigForPhase(phase: RunnablePhase): Required<PromptConfig> {
	const filename = PHASE_FILES[phase];
	let config: PromptConfig = {};
	for (const dir of [builtinPhasesDir(), path.join(userConfigDir(), "phases")]) {
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

function validateLaunches(value: unknown, filename: string, phase: RunnablePhase, profileName: string): LaunchConfig[] {
	const values = Array.isArray(value) ? value : [value];
	if (!values.length) throw new Error(`Launch config ${filename} profile ${profileName} phase ${phase} must include at least one launch.`);
	if (values.length > 1 && !PHASE_CONTRACTS[phase].parallelEligible) {
		const eligible = DELIVERY_PHASES.filter((candidate) => PHASE_CONTRACTS[candidate].parallelEligible).join(" and ");
		throw new Error(`Launch config ${filename} profile ${profileName} phase ${phase} cannot use parallel launches; only ${eligible} support parallel execution.`);
	}
	return values.map((launch, index) => validateLaunchConfig(launch, filename, `profiles.${profileName}.${phase}[${index}]`));
}

function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		const filename = path.relative(extensionDir(), filePath).replace(/^\.\.\//, filePath);
		throw new Error(`Launch config ${filename} is invalid JSON: ${(error as Error).message}`);
	}
}

function readProfileLaunchConfig(filePath: string): ProfileLaunchConfig | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const filename = path.relative(extensionDir(), filePath).replace(/^\.\.\//, filePath);
	const parsed = readJsonFile(filePath);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Launch config ${filename} must be an object with defaultProfile and profiles.`);
	const raw = parsed as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!PROFILE_KEYS.has(key)) throw new Error(`Launch config ${filename} must use profile-aware shape with defaultProfile and profiles; unexpected key: ${key}.`);
	}
	const shared = profileConfigFromRaw<unknown>(raw, filename);
	const profiles: Record<string, Record<RunnablePhase, LaunchConfig[]>> = {};
	for (const profileName of shared.profiles) {
		const phaseDefinitions = shared.profileDefinitions[profileName];
		const profileConfig: Partial<Record<RunnablePhase, LaunchConfig[]>> = {};
		for (const phase of DELIVERY_PHASES) {
			profileConfig[phase] = validateLaunches(phaseDefinitions[phase], filename, phase, profileName);
		}
		profiles[profileName] = profileConfig as Record<RunnablePhase, LaunchConfig[]>;
	}
	return { ...(shared.defaultProfile ? { defaultProfile: shared.defaultProfile } : {}), profiles };
}

function readActiveProfile(): string | undefined {
	const filePath = path.join(userConfigDir(), ACTIVE_PROFILE_FILE);
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return readActiveProfilePayload(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath, { missingProperty: "undefined" });
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Active profile config ${filePath} is invalid JSON: ${error.message}`);
		throw error;
	}
}

function selectProfile(config: ProfileLaunchConfig, definitionSource: ProfileResolution["definitionSource"]): ProfileResolution {
	const selection = selectDeliveryProfile({
		profiles: Object.keys(config.profiles),
		defaultProfile: config.defaultProfile,
		definitionSource,
		envProfile: process.env.PI_DELIVERY_PROFILE,
		savedActiveProfile: readActiveProfile(),
	});
	return { selectedProfile: selection.activeProfile, source: selection.activeSource, definitionSource, envOverride: selection.envOverride };
}

function loadLaunchConfigBundle(): { launches: Record<RunnablePhase, LaunchConfig[]>; profileResolution: ProfileResolution } {
	const globalPath = path.join(userConfigDir(), PHASE_LAUNCHES_FILE);
	const globalConfig = readProfileLaunchConfig(globalPath);
	const definitionSource: ProfileResolution["definitionSource"] = globalConfig ? "global-phase-launches" : "built-in-phase-launches";
	const config = globalConfig ?? readProfileLaunchConfig(path.join(extensionDir(), PHASE_LAUNCHES_FILE));
	if (!config) throw new Error("Built-in launch config is missing.");
	const profileResolution = selectProfile(config, definitionSource);
	return { launches: config.profiles[profileResolution.selectedProfile], profileResolution };
}

function materializeConfig(phase: RunnablePhase, prompt: Required<PromptConfig>, launches: LaunchConfig[]): PhaseConfig {
	return {
		launches,
		orchestratorInstruction: (context) => render(prompt.orchestratorInstruction, context),
		childPrompt: (context) => `${render(prompt.childPrompt, context)}\n\n${phaseArtifactContractMarkdown(phase)}`,
	};
}

export function validatePhaseLaunches(launchConfig: unknown, source = "pinned phase launch bundle"): Record<RunnablePhase, LaunchConfig[]> {
	if (!launchConfig || typeof launchConfig !== "object" || Array.isArray(launchConfig)) {
		throw new Error(`Launch config ${source} must define every runnable phase.`);
	}
	const raw = launchConfig as Record<string, unknown>;
	return Object.fromEntries(
		DELIVERY_PHASES.map((phase) => [phase, validateLaunches(raw[phase], source, phase, "pinned")]),
	) as Record<RunnablePhase, LaunchConfig[]>;
}

export function materializePhaseConfigs(launchConfig: Record<RunnablePhase, LaunchConfig[]>): Record<RunnablePhase, PhaseConfig> {
	const validatedLaunches = validatePhaseLaunches(launchConfig);
	return Object.fromEntries(
		(Object.keys(PHASE_FILES) as RunnablePhase[]).map((phase) => [phase, materializeConfig(phase, promptConfigForPhase(phase), validatedLaunches[phase])]),
	) as Record<RunnablePhase, PhaseConfig>;
}

export function loadPhaseConfigBundle(): PhaseConfigBundle {
	const { launches, profileResolution } = loadLaunchConfigBundle();
	return {
		launches,
		profileResolution,
		phases: materializePhaseConfigs(launches),
	};
}

export function loadPhaseConfigs(_cwd = process.cwd(), _projectRoot?: string, launchConfig?: Record<RunnablePhase, LaunchConfig[]>): Record<RunnablePhase, PhaseConfig> {
	return materializePhaseConfigs(launchConfig ?? loadLaunchConfigBundle().launches);
}
