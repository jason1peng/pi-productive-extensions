import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeEnvironment, type ProvisionedRun } from "./provision.ts";
import type { ScenarioRecord, UsageRecord } from "./schema.ts";
import type { RuntimeEvidence } from "./scorers/index.ts";

export interface RuntimeRun {
	evidence: RuntimeEvidence;
	outer: { provider: string; model: string; sessionFile?: string; usage?: UsageRecord };
	child?: RuntimeEvidence["effective"] & { provider: string; usage?: UsageRecord };
	/** Ephemeral comparison-only values. Never serialize these into retained evidence or results. */
	secretValues?: string[];
}

const AUTHORITATIVE_OUTPUT = /Write your findings to exactly this path:\s*([^\n]+)\nThis path is authoritative for this run\./;

function records(file: string): any[] {
	return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function usageFromRecords(entries: any[]): UsageRecord | undefined {
	const total: Required<UsageRecord> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
	let found = false;
	for (const entry of entries) {
		const usage = entry?.message?.usage ?? entry?.usage;
		if (!usage || typeof usage !== "object") continue;
		found = true;
		total.inputTokens += Number(usage.input ?? usage.inputTokens ?? 0);
		total.outputTokens += Number(usage.output ?? usage.outputTokens ?? 0);
		total.cacheReadTokens += Number(usage.cacheRead ?? usage.cacheReadTokens ?? 0);
		total.cacheWriteTokens += Number(usage.cacheWrite ?? usage.cacheWriteTokens ?? 0);
		total.costUsd += Number(usage.cost?.total ?? usage.costUsd ?? 0);
	}
	return found ? total : undefined;
}

export function resolveChild(run: ProvisionedRun, requested: RuntimeEvidence["requested"], effectiveTools: string[]): RuntimeRun["child"] {
	const metadataRoot = path.join(run.workspace, ".pi-subagents", "artifacts");
	if (!fs.existsSync(metadataRoot)) throw new Error("pi-subagents metadata directory is missing");
	const matches: Array<{ runId: string; childIndex: number; metadata: any; metadataFile: string }> = [];
	for (const name of fs.readdirSync(metadataRoot).filter((entry) => entry.endsWith("_meta.json"))) {
		const metadataFile = path.join(metadataRoot, name);
		const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
		const output = AUTHORITATIVE_OUTPUT.exec(String(metadata.task ?? ""))?.[1]?.trim();
		const index = /_(\d+)_meta\.json$/.exec(name)?.[1];
		if (metadata.agent === requested.agent && output === requested.output && index !== undefined) matches.push({ runId: String(metadata.runId ?? name.split("_")[0]), childIndex: Number(index), metadata, metadataFile });
	}
	if (matches.length !== 1) throw new Error(`expected one child metadata match, found ${matches.length}`);
	const match = matches[0];
	const sessionsRoot = path.join(run.env.PI_CODING_AGENT_DIR, "sessions");
	const candidates: string[] = [];
	function visit(directory: string): void {
		if (!fs.existsSync(directory)) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(target);
			else if (entry.name === "session.jsonl" && target.includes(`${path.sep}${match.runId}${path.sep}run-${match.childIndex}${path.sep}`)) candidates.push(target);
		}
	}
	visit(sessionsRoot);
	if (candidates.length !== 1) throw new Error(`expected one child session, found ${candidates.length}`);
	const entries = records(candidates[0]);
	const session = entries.find((entry) => entry.type === "session") ?? {};
	const model = entries.find((entry) => entry.type === "model_change") ?? {};
	const thinking = entries.find((entry) => entry.type === "thinking_level_change") ?? {};
	const effectiveModel = String(model.modelId ?? match.metadata.model ?? "");
	const requestedModelId = requested.model.includes("/") ? requested.model.slice(requested.model.indexOf("/") + 1) : requested.model;
	const effectiveCwd = String(session.cwd ?? match.metadata.cwd ?? "");
	const conversation = entries.filter((entry) => ["user", "assistant"].includes(String(entry?.message?.role ?? "")));
	const firstMessage = conversation[0]?.message;
	const firstText = (firstMessage?.content ?? []).filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")).join("\n");
	const authoritativeTask = String(match.metadata.task ?? "");
	if (requested.context !== "fresh" || authoritativeTask.length === 0 || firstMessage?.role !== "user" || !firstText.startsWith(`Task: ${authoritativeTask}`)) {
		throw new Error("effective child context could not be proven as fresh from authoritative session history");
	}
	return {
		agent: requested.agent,
		provider: String(model.provider ?? "unknown"),
		model: effectiveModel === requestedModelId ? requested.model : effectiveModel,
		thinking: String(thinking.thinkingLevel ?? match.metadata.thinking ?? ""),
		context: "fresh",
		tools: effectiveTools,
		cwd: fs.existsSync(effectiveCwd) && fs.existsSync(requested.cwd) && fs.realpathSync(effectiveCwd) === fs.realpathSync(requested.cwd) ? requested.cwd : effectiveCwd,
		sessionFile: candidates[0],
		metadataFile: match.metadataFile,
		usage: usageFromRecords(entries),
	};
}

function subagentCalls(entries: any[]): Array<{ id: string; args: any }> {
	const calls: Array<{ id: string; args: any }> = [];
	for (const entry of entries) {
		if (entry?.message?.role !== "assistant") continue;
		for (const item of entry.message.content ?? []) {
			if (item?.type === "toolCall" && item?.name === "subagent") calls.push({ id: String(item.id ?? ""), args: item.arguments ?? {} });
		}
	}
	return calls;
}

function resolvedTools(entries: any[], requested: RuntimeEvidence["requested"]): { tools?: string[]; errors: string[] } {
	const gets = subagentCalls(entries).filter((call) => call.args.action === "get" && call.args.agent === requested.agent);
	if (gets.length !== 1) return { errors: [`expected exactly one resolved-agent configuration query, found ${gets.length}`] };
	const response = entries.find((entry) => entry?.message?.role === "toolResult" && entry.message.toolCallId === gets[0].id)?.message;
	const text = (response?.content ?? []).filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")).join("\n");
	const priority: Record<string, number> = { builtin: 0, package: 1, user: 2, project: 3 };
	const configs = text.split(/\n(?=Agent: )/).map((block) => {
		const source = /^Agent: .+ \((builtin|package|user|project)\)$/m.exec(block)?.[1];
		const tools = /^Tools: (.+)$/m.exec(block)?.[1]?.split(",").map((tool) => tool.trim()).filter(Boolean);
		return source && tools ? { source, tools } : undefined;
	}).filter((entry): entry is { source: string; tools: string[] } => Boolean(entry));
	const effective = configs.sort((left, right) => priority[right.source] - priority[left.source])[0];
	if (!effective) return { errors: ["resolved-agent configuration did not report effective tools"] };
	return { tools: effective.tools, errors: [] };
}

export function validateOuterLaunch(entries: any[], requested: RuntimeEvidence["requested"]): string[] {
	const calls = subagentCalls(entries);
	const unexpectedManagement = calls.filter(({ args }) => args.action && !(args.action === "get" && args.agent === requested.agent));
	if (unexpectedManagement.length > 0) return [`unexpected parent subagent management calls: ${unexpectedManagement.map(({ args }) => String(args.action)).join(", ")}`];
	const launches: any[] = [];
	for (const { args } of calls) {
		if (args.action) continue;
		if (typeof args.agent === "string") launches.push(args);
		if (Array.isArray(args.tasks)) launches.push(...args.tasks.filter((task: any) => typeof task?.agent === "string").map((task: any) => ({ ...args, ...task, tasks: undefined })));
	}
	if (launches.length !== 1) return [`expected exactly one parent subagent launch, found ${launches.length}`];
	const launch = launches[0];
	const mismatches: string[] = (["agent", "context", "cwd", "output"] as const).filter((key) => launch[key] !== requested[key]);
	const requestedModelWithThinking = `${requested.model}:${requested.thinking}`;
	if (launch.model !== requestedModelWithThinking) mismatches.push("model/thinking");
	return mismatches.length === 0 ? [] : [`parent launch arguments mismatch: ${mismatches.join(", ")}`];
}

function childSessionCompleted(sessionFile: string): boolean {
	const lastAssistant = [...records(sessionFile)].reverse().find((entry) => entry?.message?.role === "assistant")?.message;
	return Boolean(lastAssistant) && (!lastAssistant.stopReason || ["stop", "end_turn"].includes(lastAssistant.stopReason));
}

function writeControlledAgentWrapper(repositoryRoot: string, agentDir: string, candidate: string, scenario: ScenarioRecord): void {
	if (!candidate.startsWith("dsm.")) return;
	const localName = candidate.slice("dsm.".length);
	const source = path.join(repositoryRoot, "extensions", "delivery-state-machine", "agents", "dsm", `${localName}.md`);
	if (!fs.existsSync(source)) throw new Error(`packaged agent source is missing: ${source}`);
	let contents = fs.readFileSync(source, "utf8");
	if (!/^tools:\s*.+$/m.test(contents) || !/^thinking:\s*.+$/m.test(contents)) throw new Error(`packaged agent frontmatter cannot be controlled: ${source}`);
	contents = contents
		.replace(/^tools:\s*.+$/m, `tools: ${scenario.launch.tools.join(", ")}`)
		.replace(/^thinking:\s*.+$/m, `thinking: ${scenario.launch.thinking}`);
	const target = path.join(agentDir, "agents", "dsm", `${localName}.md`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, contents, "utf8");
}

function outerSession(agentDir: string): { file?: string; records: any[] } {
	const candidates: string[] = [];
	function visit(directory: string): void {
		if (!fs.existsSync(directory)) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(target);
			else if (entry.name.endsWith(".jsonl") && !target.includes(`${path.sep}.pi-subagents${path.sep}`)) candidates.push(target);
		}
	}
	visit(path.join(agentDir, "sessions"));
	const file = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
	return file ? { file, records: records(file) } : { records: [] };
}

function evidenceSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.length === 0 ? [] : [evidenceSchema(value[0])];
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, evidenceSchema(entry)]));
	return `<${value === null ? "null" : typeof value}>`;
}

const publicEvidenceAlternatives: Record<string, unknown[]> = {
	classification: ["pass", "must-fix", "fail-closed", "pass-with-non-blocking-notes", "mr-created"],
	outcome: ["tenant-isolation-fixed", "inclusive-range-fixed", "partial-fix", "no-change-required"],
	tenantScopes: ["isolated", "shared", "leaking"],
	defaultContext: ["preserved", "changed", "missing"],
	unrelatedState: ["preserved", "modified", "deleted"],
	scope: ["cited-repair-only", "broader-refactor", "unrelated-changes"],
	committedPaths: [["candidate.txt"], [], ["candidate.txt", "unrelated.txt"]],
	remote: ["local-only", "real-remote", "none"],
	prBoundary: ["stub", "live", "none"],
	commit: [false, true],
	push: [false, true],
	prCall: [false, true],
	criticalCount: [0, 1, 2],
	criticalIssue: ["verification-missed-consumer-control", "implementation-defect", "none"],
	improvements: [["run-consumer-control", "record-exact-commands"], ["add-unit-test"], []],
	speculation: ["non-blocking", "must-fix", "omitted"],
	evidenceComplete: [false, true],
	issue: ["missing-record-rename-deletes-destination", "displayName-only-cli-failure", "no-supported-defect"],
	reproducer: ["controls/data-loss.mjs", "controls/consumer.sh", "none"],
	safeguardGap: ["shallow-tests-miss-supported-sequence", "unit-suite-misses-cli-record-shape", "no-gap"],
	supportedModel: ["single-writer", "multi-writer", "hostile-writer"],
	excludedConcern: ["concurrent-shared-mutation", "concurrent-writers", "none"],
};

function orderedEvidenceChoices(scenarioId: string, field: string, expected: unknown): unknown[] {
	const alternatives = publicEvidenceAlternatives[field];
	if (!alternatives) throw new Error(`public evidence alternatives are missing for ${scenarioId}.${field}`);
	const serializedExpected = JSON.stringify(expected);
	if (alternatives.filter((entry) => JSON.stringify(entry) === serializedExpected).length !== 1) {
		throw new Error(`public evidence alternatives must contain the expected value exactly once for ${scenarioId}.${field}`);
	}
	return [...alternatives].sort((left, right) => {
		const digest = (value: unknown) => createHash("sha256").update(`${scenarioId}:${field}:${JSON.stringify(value)}`).digest("hex");
		return digest(left).localeCompare(digest(right));
	});
}

function evidenceChoiceContract(value: unknown, scenarioId: string, field = ""): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, evidenceChoiceContract(entry, scenarioId, key)]));
	}
	return { type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, choices: orderedEvidenceChoices(scenarioId, field, value) };
}

export function publicEvidenceChoiceContract(scenario: ScenarioRecord): unknown {
	return evidenceChoiceContract(scenario.artifact.expectedEvidence, scenario.id);
}

export function artifactPrompt(scenario: ScenarioRecord, run: ProvisionedRun): string {
	const allowed = scenario.artifact.verdicts.join("|");
	return `Execute this controlled evaluation task in the fixture repository.\n\nRole: ${scenario.role}\nTask: ${scenario.task}\nAccepted invariants:\n${scenario.invariants.map((entry) => `- ${entry}`).join("\n")}\nExcluded behavior:\n${scenario.exclusions.map((entry) => `- ${entry}`).join("\n") || "- none"}\nMutation policy: only ${scenario.mutation.allowedPaths.join(", ") || "no source paths"}; Git operations ${scenario.mutation.allowedGitOperations.join(", ")}.\nRun the focused controls supplied by the fixture when relevant. Do not access network resources or any path outside the fixture and exact artifact.\n\nWrite a Markdown artifact starting with RESULT: ${allowed} and containing these headings in this order:\n${scenario.artifact.headings.join("\n")}\nInclude concrete evidence from your own investigation. Include exactly one fenced eval-evidence JSON block using the versioned field/type shape below. For each field, choose exactly one value from the public bounded choice contract based on your investigation; the scorer's expected choice remains hidden. Do not emit type placeholders or the choice-contract wrapper.\n\nField/type shape:\n${JSON.stringify(evidenceSchema(scenario.artifact.expectedEvidence), null, 2)}\n\nPublic bounded choices:\n${JSON.stringify(publicEvidenceChoiceContract(scenario), null, 2)}\n\n\`\`\`eval-evidence\n${JSON.stringify(evidenceSchema(scenario.artifact.expectedEvidence), null, 2)}\n\`\`\`\n\nWrite your findings to exactly this path: ${run.artifactPath}\nThis path is authoritative for this run.`;
}

function outerPrompt(scenario: ScenarioRecord, run: ProvisionedRun, candidate: string): string {
	const child = artifactPrompt(scenario, run);
	return `First call the subagent tool exactly once with action=get and agent=${candidate} so the runner can retain the resolved effective tool policy. Then launch exactly one subagent using these exact accepted tool arguments: agent=${candidate}, model=${scenario.launch.model}:${scenario.launch.thinking}, context=${scenario.launch.context}, cwd=${run.workspace}, output=${run.artifactPath}. The model thinking suffix is pi-subagents' supported per-launch thinking argument; the isolated agent settings independently pin thinking=${scenario.launch.thinking} and tools=${scenario.launch.tools.join(",")}. Do not list agents, retry, update configuration, or substitute agent-owned defaults. Pass the child task below without adding requirements. Do not perform the task yourself, launch another child, or treat final text as completion evidence. Wait for the child and then end.\n\n--- CHILD TASK ---\n${child}`;
}

const MANAGED_SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
	try { process.kill(-groupId, signal); }
	catch (error: any) {
		if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
	}
}

function processGroupHasLiveMembers(groupId: number): boolean {
	const table = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
	if (table.error || table.status !== 0) throw new Error(`could not inspect process group ${groupId}: ${table.error?.message ?? table.stderr.trim()}`);
	return table.stdout.split(/\r?\n/).some((line) => {
		const [pgid, state] = line.trim().split(/\s+/, 2);
		return Number(pgid) === groupId && Boolean(state) && !state.startsWith("Z");
	});
}

async function terminateProcessGroup(groupId: number, initialSignal: NodeJS.Signals, graceMs = 2_000): Promise<void> {
	signalProcessGroup(groupId, initialSignal);
	let inspectionError: unknown;
	const termDeadline = Date.now() + graceMs;
	while (Date.now() < termDeadline) {
		try {
			if (!processGroupHasLiveMembers(groupId)) return;
		} catch (error) { inspectionError = error; break; }
		await Bun.sleep(25);
	}
	signalProcessGroup(groupId, "SIGKILL");
	const killDeadline = Date.now() + Math.max(1_000, graceMs);
	while (Date.now() < killDeadline) {
		try {
			if (!processGroupHasLiveMembers(groupId)) return;
		} catch (error) { inspectionError ??= error; }
		await Bun.sleep(25);
	}
	if (inspectionError) throw inspectionError;
	throw new Error(`process group ${groupId} retained live members after cleanup`);
}

export async function spawnBounded(command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; stdout: string; stderr: string }): Promise<{ code: number | null; timedOut: boolean }> {
	const stdout = fs.openSync(options.stdout, "w");
	const stderr = fs.openSync(options.stderr, "w");
	let child: ReturnType<typeof spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const observedSignals: NodeJS.Signals[] = [];
	let groupId: number | undefined;
	let cleanup: Promise<void> | undefined;
	let cleanupError: unknown;
	const handlers = new Map<NodeJS.Signals, () => void>();
	const displacedHandlers = new Map<NodeJS.Signals, Array<(...args: any[]) => void>>();
	const ensureCleanup = (signal: NodeJS.Signals): Promise<void> => groupId === undefined ? Promise.resolve() : cleanup ??= terminateProcessGroup(groupId, signal);
	try {
		// Install handlers before spawning so cancellation cannot land in the
		// detached-child/handler-registration gap and orphan the new group.
		for (const signal of MANAGED_SIGNALS) {
			// A synchronous pre-existing listener (notably process.exit) can end
			// an embedded host before async group cleanup completes. Temporarily
			// displace existing listeners, then restore and replay the signal only
			// after the managed child group is verified inert.
			const existing = process.rawListeners(signal) as Array<(...args: any[]) => void>;
			displacedHandlers.set(signal, existing);
			for (const listener of existing) process.removeListener(signal, listener);
			const handler = () => {
				observedSignals.push(signal);
				if (groupId === undefined) return;
				if (cleanup) signalProcessGroup(groupId, signal);
				else void ensureCleanup(signal).catch((error) => { cleanupError ??= error; });
			};
			handlers.set(signal, handler);
			process.on(signal, handler);
		}
		child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", stdout, stderr] });
		groupId = child.pid!;
		if (observedSignals.length > 0) {
			void ensureCleanup(observedSignals[0]).catch((error) => { cleanupError ??= error; });
			for (const signal of observedSignals.slice(1)) signalProcessGroup(groupId, signal);
		}
		let timedOut = false;
		timer = setTimeout(() => {
			timedOut = true;
			void ensureCleanup("SIGTERM").catch((error) => { cleanupError ??= error; });
		}, options.timeoutMs);
		const code = await new Promise<number | null>((resolve) => child!.once("close", resolve));
		clearTimeout(timer);
		timer = undefined;
		try { await ensureCleanup("SIGTERM"); }
		catch (error) { cleanupError ??= error; }
		if (cleanupError && observedSignals.length === 0) throw cleanupError;
		return { code, timedOut };
	} finally {
		if (timer) clearTimeout(timer);
		for (const [signal, handler] of handlers) process.off(signal, handler);
		for (const signal of MANAGED_SIGNALS) {
			for (const listener of displacedHandlers.get(signal) ?? []) process.on(signal, listener);
		}
		fs.closeSync(stdout);
		fs.closeSync(stderr);
		if (observedSignals.length > 0) {
			if (cleanupError) console.error(`process-group cleanup failed during ${observedSignals.join(",")}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			for (const signal of observedSignals) {
				const hasHostHandlers = (displacedHandlers.get(signal)?.length ?? 0) > 0;
				process.kill(process.pid, signal);
				// Allow restored listeners to run before replaying the next observed
				// signal. A signal without a listener preserves normal POSIX exit.
				if (!hasHostHandlers) await new Promise<never>(() => {});
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (cleanupError) throw cleanupError;
		}
	}
}

function readAuthFile(authFile: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(fs.readFileSync(authFile, "utf8")); }
	catch (error) { throw new Error(`authentication file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("authentication file must be a provider-keyed object");
	return parsed as Record<string, unknown>;
}

function credentialValues(value: unknown): string[] {
	const values = new Set<string>();
	function visit(entry: unknown): void {
		if (Array.isArray(entry)) { entry.forEach(visit); return; }
		if (entry === null || typeof entry !== "object") return;
		for (const [key, nested] of Object.entries(entry)) {
			if (typeof nested === "string" && /(access|refresh|token|key|secret|password|credential|auth)/i.test(key) && nested.length >= 8) values.add(nested);
			else visit(nested);
		}
	}
	visit(value);
	return [...values];
}

export function credentialValuesFromAuthFile(authFile: string): string[] {
	if (!fs.existsSync(authFile)) return [];
	return credentialValues(readAuthFile(authFile));
}

function modelProvider(model: string): string {
	const separator = model.indexOf("/");
	if (separator < 1) throw new Error(`model must be provider-qualified for credential isolation: ${model}`);
	return model.slice(0, separator);
}

export function selectAuthentication(authFile: string, models: string[]): { contents?: string; secretValues: string[]; providers: string[] } {
	const providers = [...new Set(models.map(modelProvider))].sort();
	if (!fs.existsSync(authFile)) return { secretValues: [], providers };
	const source = readAuthFile(authFile);
	const selected = Object.fromEntries(providers.filter((provider) => provider in source).map((provider) => [provider, source[provider]]));
	return {
		...(Object.keys(selected).length > 0 ? { contents: `${JSON.stringify(selected, null, 2)}\n` } : {}),
		secretValues: credentialValues(selected),
		providers,
	};
}

export async function executePiRuntime(scenario: ScenarioRecord, candidate: string, run: ProvisionedRun): Promise<RuntimeRun> {
	const requested: RuntimeEvidence["requested"] = { agent: candidate, model: scenario.launch.model, thinking: scenario.launch.thinking, context: scenario.launch.context, tools: scenario.launch.tools, cwd: run.workspace, output: run.artifactPath };
	const infrastructureErrors: string[] = [];
	const originalHome = os.homedir();
	const agentDir = run.env.PI_CODING_AGENT_DIR;
	fs.mkdirSync(agentDir, { recursive: true });
	const launchEnv = runtimeEnvironment(run.env, scenario.environment.allow);
	for (const name of scenario.environment.allow) {
		if (!/(TOKEN|KEY|SECRET|AUTH|PASSWORD|CREDENTIAL)/i.test(name)) continue;
		const value = launchEnv[name];
		if (value && value.length >= 8) run.secretValues.push(value);
	}
	const authSource = process.env.PI_AGENT_AUTH_FILE ?? path.join(originalHome, ".pi", "agent", "auth.json");
	const outerModel = process.env.DSM_AGENT_EVAL_OUTER_MODEL ?? scenario.launch.model;
	let secretValues: string[] = [];
	if (fs.existsSync(authSource)) {
		try {
			const authentication = selectAuthentication(authSource, [outerModel, scenario.launch.model]);
			secretValues = authentication.secretValues;
			run.secretValues.push(...authentication.secretValues);
			if (authentication.contents) fs.writeFileSync(path.join(agentDir, "auth.json"), authentication.contents, { mode: 0o600 });
		}
		catch (error) { infrastructureErrors.push(error instanceof Error ? error.message : String(error)); }
	}
	const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
	const subagentsRoot = process.env.PI_SUBAGENTS_ROOT ?? path.join(originalHome, ".pi", "agent", "npm", "node_modules", "pi-subagents");
	if (!fs.existsSync(subagentsRoot)) infrastructureErrors.push(`pi-subagents not found: ${subagentsRoot}`);
	try { writeControlledAgentWrapper(repositoryRoot, agentDir, candidate, scenario); }
	catch (error) { infrastructureErrors.push(error instanceof Error ? error.message : String(error)); }
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: scenario.launch.model, subagents: { defaultModel: scenario.launch.model, agentOverrides: { [candidate]: { thinking: scenario.launch.thinking, tools: scenario.launch.tools } } }, packages: [subagentsRoot, repositoryRoot] }, null, 2));
	const outerOutput = path.join(run.rawEvidence, "outer.txt");
	const outerError = path.join(run.rawEvidence, "outer.stderr.txt");
	let code: number | null = null;
	let timedOut = false;
	if (infrastructureErrors.length === 0) {
		const execution = await spawnBounded(process.env.PI_BIN ?? "pi", ["--approve", "--print", "--extension", path.join(subagentsRoot, "src", "extension", "index.ts"), "--model", outerModel, outerPrompt(scenario, run, candidate)], { cwd: run.workspace, env: launchEnv, timeoutMs: scenario.launch.timeoutMs, stdout: outerOutput, stderr: outerError });
		code = execution.code;
		timedOut = execution.timedOut;
		if (code !== 0 && !timedOut) infrastructureErrors.push(`outer Pi exited ${String(code)}`);
	}
	const outer = outerSession(agentDir);
	const configuredTools = resolvedTools(outer.records, requested);
	infrastructureErrors.push(...configuredTools.errors, ...validateOuterLaunch(outer.records, requested));
	let child: RuntimeRun["child"];
	if (infrastructureErrors.length === 0 && configuredTools.tools) {
		try { child = resolveChild(run, requested, configuredTools.tools); }
		catch (error) {
			if (!timedOut) infrastructureErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (timedOut && !child) infrastructureErrors.push("outer deadline expired before authoritative child start could be proven");
	fs.writeFileSync(path.join(run.rawEvidence, "requested-launch.json"), `${JSON.stringify(requested, null, 2)}\n`);
	return {
		evidence: { requested, effective: child, started: Boolean(child), completed: child ? childSessionCompleted(child.sessionFile) && fs.existsSync(run.artifactPath) : false, timedOut, infrastructureErrors },
		outer: { provider: outer.records.find((entry) => entry.type === "model_change")?.provider ?? "unknown", model: outerModel, sessionFile: outer.file, usage: usageFromRecords(outer.records) },
		child,
		secretValues,
	};
}
