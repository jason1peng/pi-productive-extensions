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

export interface PhaseConfig extends LaunchConfig {
	parallel?: LaunchConfig[];
	orchestratorInstruction: (context: PhasePromptContext) => string;
	childPrompt: (context: PhasePromptContext) => string;
}

interface RawPhaseConfig extends LaunchConfig {
	orchestratorInstruction: string;
	childPrompt: string;
}

const PHASE_FILES: Record<RunnablePhase, string> = {
	IMPLEMENT: "implement.md",
	VERIFY: "verify.md",
	REVIEW: "review.md",
	CLOSE: "close.md",
	RETRO: "retro.md",
};

const PARALLEL_CONFIG_FILE = "phase-parallel.json";

const VALID_THINKING = new Set(["low", "medium", "high"]);
const VALID_CONTEXT = new Set(["fresh", "fork"]);

function extensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function phasesDir(): string {
	return path.join(extensionDir(), "phases");
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
		const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
		data[key] = value;
	}
	return { data, body };
}

function section(markdown: string, heading: string, filename: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`^##\\s+${escaped}\\s*$`, "im").exec(markdown);
	if (!match) throw new Error(`Phase config ${filename} is missing section: ## ${heading}`);
	const tail = markdown.slice(match.index + match[0].length);
	const nextHeading = tail.search(/^##\s+/m);
	return tail.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}

function render(template: string, context: PhasePromptContext): string {
	const values = context as unknown as Record<string, string | number | undefined>;
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => String(values[key] ?? ""));
}

function validateLaunchConfig(config: LaunchConfig, filename: string, label: string) {
	if (!config.agent) throw new Error(`Phase config ${filename} has ${label} without required agent.`);
	if (config.thinking && !VALID_THINKING.has(config.thinking)) throw new Error(`Phase config ${filename} has invalid ${label}.thinking=${config.thinking}.`);
	if (config.context && !VALID_CONTEXT.has(config.context)) throw new Error(`Phase config ${filename} has invalid ${label}.context=${config.context}.`);
}

function validateParallelLaunches(launches: LaunchConfig[] | undefined, filename: string): LaunchConfig[] | undefined {
	if (!launches?.length) return undefined;
	launches.forEach((launch, index) => validateLaunchConfig(launch, filename, `parallel[${index}]`));
	return launches;
}

function readParallelConfig(): Partial<Record<RunnablePhase, LaunchConfig[]>> {
	const filePath = path.join(extensionDir(), PARALLEL_CONFIG_FILE);
	if (!fs.existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Parallel config ${PARALLEL_CONFIG_FILE} is invalid JSON: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Parallel config ${PARALLEL_CONFIG_FILE} must be an object keyed by phase.`);
	const config: Partial<Record<RunnablePhase, LaunchConfig[]>> = {};
	for (const [phase, launches] of Object.entries(parsed as Record<string, unknown>)) {
		if (!(phase in PHASE_FILES)) throw new Error(`Parallel config ${PARALLEL_CONFIG_FILE} has unknown phase: ${phase}`);
		if (!Array.isArray(launches)) throw new Error(`Parallel config ${PARALLEL_CONFIG_FILE} phase ${phase} must be an array.`);
		config[phase as RunnablePhase] = validateParallelLaunches(launches as LaunchConfig[], `${PARALLEL_CONFIG_FILE}.${phase}`);
	}
	return config;
}

function readRawPhaseConfig(phase: RunnablePhase, filename: string): RawPhaseConfig {
	const filePath = path.join(phasesDir(), filename);
	const markdown = fs.readFileSync(filePath, "utf8");
	const { data, body } = parseFrontmatter(markdown, filename);
	if (data.phase && data.phase !== phase) throw new Error(`Phase config ${filename} declares phase=${data.phase}, expected ${phase}.`);
	if (!data.agent) throw new Error(`Phase config ${filename} is missing required frontmatter: agent.`);
	if (data.tools) throw new Error(`Phase config ${filename} must not declare tools; subagent tools come from the actual agent definition.`);
	const primary: LaunchConfig = {
		agent: data.agent,
		model: data.model || undefined,
		thinking: data.thinking as RawPhaseConfig["thinking"],
		context: data.context as RawPhaseConfig["context"],
	};
	validateLaunchConfig(primary, filename, "primary launch");
	if (data.parallel) throw new Error(`Phase config ${filename} must not declare parallel; configure parallel launches in ${PARALLEL_CONFIG_FILE}.`);
	return {
		...primary,
		orchestratorInstruction: section(body, "Orchestrator instruction", filename),
		childPrompt: section(body, "Child prompt", filename),
	};
}

function materializeConfig(raw: RawPhaseConfig, parallel?: LaunchConfig[]): PhaseConfig {
	return {
		agent: raw.agent,
		model: raw.model,
		thinking: raw.thinking,
		context: raw.context,
		parallel,
		orchestratorInstruction: (context) => render(raw.orchestratorInstruction, context),
		childPrompt: (context) => render(raw.childPrompt, context),
	};
}

function loadPhaseConfigs(): Record<RunnablePhase, PhaseConfig> {
	const parallelConfig = readParallelConfig();
	return Object.fromEntries(
		(Object.entries(PHASE_FILES) as Array<[RunnablePhase, string]>).map(([phase, filename]) => [phase, materializeConfig(readRawPhaseConfig(phase, filename), parallelConfig[phase])]),
	) as Record<RunnablePhase, PhaseConfig>;
}

export const PHASE_CONFIG: Record<RunnablePhase, PhaseConfig> = loadPhaseConfigs();
