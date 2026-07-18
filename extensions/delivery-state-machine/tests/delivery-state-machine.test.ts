import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectSessionUsage, collectUsageFromJsonlContent, subtractUsageTotals } from "../../../shared/session-usage.ts";
import deliveryStateMachine from "../index.ts";
import { PHASE_CONTRACTS, phaseArtifactContractMarkdown, renderPhaseArtifactMarkdown, type RunnablePhase, type Verdict } from "../phase-contract.ts";
import { materializePhaseConfigs } from "../phase-config.ts";
import { readPiSubagentMetadataFiles, resolvePiSubagentChildUsage, usageFromPiSubagentMetadata } from "../pi-subagents-usage.ts";

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

interface RegisteredTool {
	promptGuidelines?: string[];
	execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: FakeContext) => Promise<any>;
}

interface FakeContext {
	cwd: string;
	hasUI: boolean;
	isProjectTrusted: () => boolean;
	ui: {
		notify: () => void;
		theme: { fg: (_kind: string, text: string) => string };
		setStatus: () => void;
		setWidget: () => void;
	};
	sessionManager: {
		getSessionFile: () => string | undefined;
		getBranch: () => never[];
	};
}

const artifactDirs = new Set<string>();

async function withTemporaryUserExtensionFile<T>(relativePath: string, content: string, fn: () => Promise<T>): Promise<T> {
	const target = path.join(testAgentDir, "extensions", "delivery-state-machine", relativePath);
	const backup = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf8");
	try {
		return await fn();
	} finally {
		if (backup === undefined) fs.rmSync(target, { force: true });
		else fs.writeFileSync(target, backup);
	}
}

function createHarness(options: { cwd?: string; sessionFile?: string; branchEntries?: any[]; projectTrusted?: boolean } = {}) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
	const eventHandlers = new Map<string, (event: unknown, ctx: FakeContext) => Promise<any>>();
	const sentMessages: string[] = [];
	const appendedEntries: Array<{ type: "custom"; customType: string; data: unknown }> = [];

	const pi = {
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		on(eventName: string, handler: (event: unknown, ctx: FakeContext) => Promise<any>) {
			eventHandlers.set(eventName, handler);
		},
		registerTool(tool: RegisteredTool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: FakeContext) => Promise<void> }) {
			commands.set(name, command);
		},
		setSessionName() {},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
	};

	const ctx: FakeContext = {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		isProjectTrusted: () => options.projectTrusted ?? true,
		ui: {
			notify() {},
			theme: { fg: (_kind, text) => text },
			setStatus() {},
			setWidget() {},
		},
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getBranch: () => (options.branchEntries ?? []) as never[],
		},
	};

	deliveryStateMachine(pi as any);

	async function emit(eventName: string, event: unknown = {}) {
		const handler = eventHandlers.get(eventName);
		if (!handler) throw new Error(`Event handler not registered: ${eventName}`);
		return handler(event, ctx);
	}

	let currentArtifactDir: string | undefined;
	let currentPlannedArtifact: string | undefined;
	async function tool(name: string, params: Record<string, unknown> = {}) {
		const registered = tools.get(name);
		if (!registered) throw new Error(`Tool not registered: ${name}`);
		const callParams = { ...params };
		const omitArtifact = callParams.__omitArtifact === true;
		delete callParams.__omitArtifact;
		if (name === "delivery_report" && !omitArtifact && !callParams.artifact && ["PASS", "PASS_WITH_NON_BLOCKING_NOTES", "FAIL", "INCONCLUSIVE", "DONE", "MR_CREATED"].includes(String(callParams.verdict)) && callParams.phase !== "REVIEW") {
			if (!currentArtifactDir) {
				currentArtifactDir = /User-scope artifact directory for this run: ([^\n]+)/.exec(sentMessages.at(-1) ?? "")?.[1];
				if (currentArtifactDir) artifactDirs.add(currentArtifactDir);
			}
			const contract = PHASE_CONTRACTS[String(callParams.phase) as RunnablePhase];
			const artifact = currentPlannedArtifact ?? path.join(currentArtifactDir!, `${contract?.artifactStem ?? `test-${String(callParams.phase).toLowerCase()}`}.md`);
			fs.writeFileSync(artifact, phaseArtifactContents(String(callParams.phase), String(callParams.verdict), String(callParams.summary ?? "test artifact")), "utf8");
			callParams.artifact = artifact;
		}
		const result = await registered.execute(`test-${name}`, callParams, undefined, undefined, ctx);
		const artifactDir = result?.details?.state?.artifactDir;
		currentPlannedArtifact = result?.details?.next?.artifact ?? result?.details?.state?.steps?.findLast((step: any) => step.status === "planned" && step.childIndex === undefined)?.artifact;
		if (artifactDir) {
			currentArtifactDir = artifactDir;
			artifactDirs.add(artifactDir);
		}
		return result;
	}

	return { tools, commands, eventHandlers, sentMessages, appendedEntries, ctx, tool, emit };
}

const testFailures: Array<{ name: string; error: unknown }> = [];

async function runTest(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		testFailures.push({ name, error });
		console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		for (const dir of artifactDirs) fs.rmSync(dir, { recursive: true, force: true });
		artifactDirs.clear();
	}
}

async function assertReportRejectedAndInert(
	harness: ReturnType<typeof createHarness>,
	params: Record<string, unknown>,
	pattern: RegExp,
) {
	const before = (await harness.tool("delivery_status")).details.state;
	const beforeEntries = harness.appendedEntries.length;
	const beforeFiles = fs.readdirSync(before.artifactDir).sort();
	await assert.rejects(() => harness.tool("delivery_report", { ...params, __omitArtifact: true }), pattern);
	const after = (await harness.tool("delivery_status")).details.state;
	assert.deepEqual(after, before, "rejected report must leave state unchanged");
	assert.equal(harness.appendedEntries.length, beforeEntries, "rejected report must not persist state");
	assert.deepEqual(fs.readdirSync(before.artifactDir).sort(), beforeFiles, "rejected report must not write artifacts");
}

async function advanceHarnessToPhase(harness: ReturnType<typeof createHarness>, target: "IMPLEMENT" | "VERIFY" | "REVIEW" | "CLOSE" | "RETRO" | "DONE") {
	let result = await harness.tool("delivery_start", { task: `advance to ${target}` });
	if (target === "IMPLEMENT") return result;
	result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	if (target === "VERIFY") return result;
	result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	if (target === "REVIEW") return result;
	const reviewNext = await harness.tool("delivery_next");
	for (const launch of reviewNext.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");
	result = await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "reviewed" });
	if (target === "CLOSE") return result;
	result = await harness.tool("delivery_report", { phase: "CLOSE", verdict: "DONE", summary: "closed" });
	if (target === "RETRO") return result;
	return harness.tool("delivery_report", { phase: "RETRO", verdict: "DONE", summary: "retrospective complete" });
}

await runTest("package manifest exposes exactly five package-qualified DSM agents with phase-safe tools", async () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi?.subagents?.agents, ["./extensions/delivery-state-machine/agents/dsm"]);
	const agentsDir = path.join(root, manifest.pi.subagents.agents[0]);
	const files = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".md")).sort();
	const expected: Record<string, { phase: RunnablePhase; tools: string[]; thinking?: "low" | "high" }> = {
		"closer.md": { phase: "CLOSE", tools: ["read", "bash"], thinking: "low" },
		"implementer.md": { phase: "IMPLEMENT", tools: ["read", "bash", "edit", "write"] },
		"retrospective.md": { phase: "RETRO", tools: ["read", "bash"], thinking: "high" },
		"reviewer.md": { phase: "REVIEW", tools: ["read", "bash"] },
		"verifier.md": { phase: "VERIFY", tools: ["read", "bash"], thinking: "low" },
	};
	assert.deepEqual(files, Object.keys(expected));
	for (const file of files) {
		const markdown = fs.readFileSync(path.join(agentsDir, file), "utf8");
		const frontmatter = markdown.split("---", 3)[1];
		assert.match(frontmatter, /\npackage: dsm\n/);
		assert.match(frontmatter, new RegExp(`\\nname: ${path.basename(file, ".md")}\\n`));
		assert.match(frontmatter, new RegExp(`\\ntools: ${expected[file].tools.join(", ")}\\n`));
		if (expected[file].thinking) assert.match(frontmatter, new RegExp(`\\nthinking: ${expected[file].thinking}\\n`));
		else assert.doesNotMatch(frontmatter, /\nthinking:/);
		assert.match(frontmatter, /\nextensions:\n/);
		assert.doesNotMatch(frontmatter, /delivery_|subagent|edit, write.*(?:verifier|reviewer)/);
		const contract = PHASE_CONTRACTS[expected[file].phase];
		for (const verdict of contract.allowedVerdicts) assert.ok(markdown.includes(`RESULT: ${verdict}`), `${file} must agree with ${expected[file].phase} verdict ${verdict}`);
		for (const heading of contract.requiredHeadings) assert.ok(markdown.includes(`\`${heading}\``), `${file} must agree with ${expected[file].phase} heading ${heading}`);
		assert.match(markdown, /Before returning, inspect the completed artifact and verify that its harness heading is the exact level-2 line `## Project harness discovery and compliance`; `###` or any other heading level is invalid\./);
		assert.match(markdown, /Discover the project harness with a bounded, best-effort check/);
		assert.match(markdown, /Never call `delivery_report`; the parent owns phase reporting and advancement/);
		assert.match(markdown, /Dynamic task\/state text|Treat task\/state text/);
	}
});

await runTest("pi-subagents discovers DSM roles from the package in an isolated project when the host package is available", async () => {
	const moduleRoot = (process.env.NODE_PATH ?? "").split(path.delimiter).find((entry) => fs.existsSync(path.join(entry, "pi-subagents", "src", "agents", "agents.ts")));
	if (!moduleRoot) {
		console.log("  SKIP host discovery smoke: pi-subagents is not installed in NODE_PATH");
		return;
	}
	const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-package-discovery-"));
	const isolatedAgentDir = path.join(isolatedRoot, "agent-home");
	const packageRoot = path.join(isolatedRoot, "package");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
		fs.mkdirSync(path.join(packageRoot, "extensions", "delivery-state-machine"), { recursive: true });
		fs.copyFileSync(path.join(sourceRoot, "package.json"), path.join(packageRoot, "package.json"));
		fs.cpSync(path.join(sourceRoot, "extensions", "delivery-state-machine", "agents", "dsm"), path.join(packageRoot, "extensions", "delivery-state-machine", "agents", "dsm"), { recursive: true });
		fs.mkdirSync(isolatedAgentDir);
		fs.writeFileSync(path.join(isolatedAgentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
		const { discoverAgentsAll } = await import(pathToFileURL(path.join(moduleRoot, "pi-subagents", "src", "agents", "agents.ts")).href);
		const all = discoverAgentsAll(isolatedRoot);
		const discovered = all.package;
		assert.deepEqual(all.user, []);
		assert.deepEqual(all.project, []);
		assert.deepEqual(discovered.map((agent: any) => agent.name).sort(), ["dsm.closer", "dsm.implementer", "dsm.retrospective", "dsm.reviewer", "dsm.verifier"]);
		for (const agent of discovered) {
			assert.equal(agent.source, "package");
			assert.equal(agent.packageName, "dsm");
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(isolatedRoot, { recursive: true, force: true });
	}
});

await runTest("isolated host smoke exercises the bundled candidate profile unchanged", () => {
	const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	const smoke = fs.readFileSync(path.join(extensionDir, "scripts", "isolated-host-smoke.sh"), "utf8");
	assert.doesNotMatch(smoke, /cat > .*phase-launches\.json/);
	assert.match(smoke, /bundled-phase-launches\.json/);
	assert.match(smoke, /requested-launches\.json/);
	assert.match(smoke, /actual-launches\.json/);
	assert.match(smoke, /"subagents": \{\s*"defaultModel": "\$MODEL"/);
	assert.match(smoke, /When delivery_next returns parallel launches, launch every parallel entry/);
	assert.match(smoke, /export PYTHONDONTWRITEBYTECODE=1/);
	assert.equal((smoke.match(/python3 -B/g) ?? []).length, 2);
	assert.match(smoke, /source-status-before\.txt/);
	assert.match(smoke, /source-status-after\.txt/);
	assert.match(smoke, /cmp -s .*source-status-before\.txt.*source-status-after\.txt/);
	assert.match(smoke, /TEMP_AGENT_ROOT=.*mktemp -d/);
	assert.match(smoke, /AGENT_DIR="\$TEMP_AGENT_ROOT\/agent"/);
	assert.doesNotMatch(smoke, /AGENT_DIR="\$EVIDENCE_DIR\/agent"/);
	assert.match(smoke, /trap cleanup_agent_home EXIT/);
	assert.match(smoke, /trap 'forward_host_signal HUP 129' HUP/);
	assert.match(smoke, /trap 'forward_host_signal INT 130' INT/);
	assert.match(smoke, /trap 'forward_host_signal TERM 143' TERM/);
	assert.match(smoke, /kill -s "\$signal_name" "\$SMOKE_HOST_PID"/);
	assert.match(smoke, /from isolated_host_process import process_group_guard/);
	assert.match(smoke, /with process_group_guard\(process, on_cleanup=record_cleanup\)/);
	assert.match(smoke, /find "\$EVIDENCE_DIR" -type f .*'auth\.json'.*'credentials\.json'.*'oauth\.json'/);
	assert.match(smoke, /args\.get\("tasks"\).*isinstance\(args\.get\("tasks"\), list\)/);
	assert.match(smoke, /printf '\.pi-subagents\/\\n'.*PROJECT_DIR\/\.gitignore/);
	assert.match(smoke, /assert_effective_model\(evidence, os\.environ\["DSM_SMOKE_EXPECTED_MODEL"\]\)/);
	assert.match(smoke, /assert_delivery_done\(Path\(os\.environ\["DSM_SMOKE_DELIVERY_ROOT"\]\)\)/);
	assert.doesNotMatch(smoke, /grep -Fq "DSM_DELIVERY_SMOKE_DONE"/);
});

await runTest("isolated smoke evidence rejects effective-model mismatch and false DONE signaling", () => {
	const helperDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-smoke-evidence-"));
	try {
		const deliveryRoot = path.join(fixture, "delivery");
		fs.mkdirSync(deliveryRoot, { recursive: true });
		fs.writeFileSync(path.join(fixture, "orchestrator.txt"), "DSM_DELIVERY_SMOKE_DONE\n");
		fs.writeFileSync(path.join(deliveryRoot, "delivery-report.json"), JSON.stringify({ state: { phase: "STOPPED" } }));
		assert.throws(() => execFileSync("python3", [
			"-B", "-c",
			"import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from isolated_host_smoke_evidence import assert_delivery_done; assert_delivery_done(Path(sys.argv[2]))",
			helperDir, deliveryRoot,
		]), /authoritative delivery report is not DONE/);
		assert.throws(() => execFileSync("python3", [
			"-B", "-c",
			"import sys; sys.path.insert(0,sys.argv[1]); from isolated_host_smoke_evidence import assert_effective_model; assert_effective_model({'provider':'openai','modelId':'wrong'},'openai/expected')",
			helperDir,
		]), /actual child model did not match DSM_SMOKE_MODEL/);
		fs.writeFileSync(path.join(deliveryRoot, "delivery-report.json"), JSON.stringify({ state: { phase: "DONE" } }));
		execFileSync("python3", [
			"-B", "-c",
			"import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from isolated_host_smoke_evidence import assert_delivery_done,assert_effective_model; assert_delivery_done(Path(sys.argv[2])); assert_effective_model({'provider':'openai','modelId':'expected'},'openai/expected')",
			helperDir, deliveryRoot,
		]);
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

await runTest("isolated host process guard reaps the detached group on HUP, INT, and TERM", async () => {
	const helperDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
	for (const [signalNumber, expectedExit] of [[1, 129], [2, 130], [15, 143]] as const) {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-process-guard-"));
		const childPidPath = path.join(fixture, "child.pid");
		const readyPath = path.join(fixture, "ready");
		const wrapper = `
import os, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
from isolated_host_process import process_group_guard
child_code = "import os,signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1],'w').write(str(os.getpid())); time.sleep(60)"
process = subprocess.Popen([sys.executable, "-c", child_code, sys.argv[2]], start_new_session=True)
with process_group_guard(process, grace_seconds=0.2):
    open(sys.argv[3], "w").write("ready")
    while process.poll() is None:
        time.sleep(0.05)
`;
		const host = Bun.spawn(["python3", "-B", "-c", wrapper, helperDir, childPidPath, readyPath], { stdout: "pipe", stderr: "pipe" });
		try {
			for (let attempt = 0; attempt < 100 && !(fs.existsSync(readyPath) && fs.existsSync(childPidPath)); attempt++) await Bun.sleep(10);
			assert.ok(fs.existsSync(readyPath) && fs.existsSync(childPidPath), `process guard did not become ready for signal ${signalNumber}`);
			const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
			host.kill(signalNumber);
			assert.equal(await host.exited, expectedExit);
			assert.throws(() => process.kill(childPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
		} finally {
			if (host.exitCode === null) host.kill(9);
			await host.exited;
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	}
});

await runTest("isolated host process guard cleans up descendants after the group leader exits", async () => {
	const helperDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-process-guard-dead-leader-"));
	const descendantPidPath = path.join(fixture, "descendant.pid");
	const wrapper = `
import os, subprocess, sys
sys.path.insert(0, sys.argv[1])
from isolated_host_process import process_group_guard
leader_code = '''
import os, subprocess, sys, time
subprocess.Popen([sys.executable, "-c", "import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1],'w').write(str(__import__('os').getpid())); time.sleep(60)", sys.argv[1]])
while not os.path.exists(sys.argv[1]):
    time.sleep(0.01)
'''
process = subprocess.Popen([sys.executable, "-c", leader_code, sys.argv[2]], start_new_session=True)
process.wait()
with process_group_guard(process, grace_seconds=0.2):
    pass
`;
	const host = Bun.spawn(["python3", "-B", "-c", wrapper, helperDir, descendantPidPath], { stdout: "pipe", stderr: "pipe" });
	let descendantPid: number | undefined;
	try {
		for (let attempt = 0; attempt < 100 && !fs.existsSync(descendantPidPath); attempt++) await Bun.sleep(10);
		assert.ok(fs.existsSync(descendantPidPath), "detached descendant did not become ready");
		descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
		assert.equal(await host.exited, 0);
		assert.throws(() => process.kill(descendantPid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
	} finally {
		if (host.exitCode === null) host.kill(9);
		await host.exited;
		if (descendantPid !== undefined) {
			try { process.kill(descendantPid, 9); } catch {}
		}
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

await runTest("isolated smoke launch evidence ignores parent and sibling output-path references", () => {
	const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	const helperDir = path.join(extensionDir, "scripts");
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-launch-evidence-"));
	try {
		const metadataDir = path.join(fixture, "project", ".pi-subagents", "artifacts");
		const sessionsDir = path.join(fixture, "sessions");
		const firstOutput = path.join(fixture, "03-review-1.md");
		const secondOutput = path.join(fixture, "03-review-2.md");
		fs.mkdirSync(metadataDir, { recursive: true });
		for (const [runId, childIndex, ownOutput, referencedOutput] of [
			["reviewrun", 0, firstOutput, secondOutput],
			["reviewrun", 1, secondOutput, firstOutput],
		] as const) {
			fs.writeFileSync(path.join(metadataDir, `${runId}_dsm.reviewer_${childIndex}_meta.json`), JSON.stringify({
				runId,
				agent: "dsm.reviewer",
				task: `Parent/sibling context references ${referencedOutput}.\nWrite your findings to exactly this path: ${ownOutput}\nThis path is authoritative for this run.`,
			}));
			const sessionPath = path.join(sessionsDir, runId, `run-${childIndex}`, "session.jsonl");
			fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
			fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: `child-${childIndex}` })}\n`);
		}
		fs.mkdirSync(path.join(sessionsDir, "parent"), { recursive: true });
		fs.writeFileSync(path.join(sessionsDir, "parent", "session.jsonl"), JSON.stringify({ outputs: [firstOutput, secondOutput] }));
		const resolved = execFileSync("python3", [
			"-B",
			"-c",
			"import json,sys; sys.path.insert(0,sys.argv[1]); from pathlib import Path; from isolated_host_launch_evidence import resolve_child_session; path,records=resolve_child_session(Path(sys.argv[2]),Path(sys.argv[3]),'dsm.reviewer',sys.argv[4]); print(json.dumps({'path':str(path),'id':records[0]['id']}))",
			helperDir,
			metadataDir,
			sessionsDir,
			secondOutput,
		], { encoding: "utf8" });
		assert.deepEqual(JSON.parse(resolved), {
			path: path.join(sessionsDir, "reviewrun", "run-1", "session.jsonl"),
			id: "child-1",
		});
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

await runTest("isolated host smoke removes inherited subagent identity markers at runtime", () => {
	const helperDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
	const output = execFileSync("python3", [
		"-B",
		"-c",
		"import json, os, sys; sys.path.insert(0, sys.argv[1]); from isolated_host_environment import isolated_host_environment; print(json.dumps(isolated_host_environment(os.environ), sort_keys=True))",
		helperDir,
	], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			PI_CODING_AGENT: "1",
			PI_COMS_SERVER: "caller-server",
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_DEPTH: "2",
			PI_SUBAGENT_MAX_DEPTH: "2",
			PI_SUBAGENT_RUN_ID: "caller-run",
			PI_SUBAGENT_PARENT_SESSION: "caller-session",
			PI_SUBAGENT_FUTURE_MARKER: "must-also-be-removed",
			PI_SUBAGENTS_ROOT: "/package/config-not-a-child-marker",
			DSM_SMOKE_SENTINEL: "preserved",
		},
	});
	const sanitized = JSON.parse(output);
	assert.equal(sanitized.DSM_SMOKE_SENTINEL, "preserved");
	assert.equal(sanitized.PI_SUBAGENTS_ROOT, "/package/config-not-a-child-marker");
	assert.equal(sanitized.PI_CODING_AGENT, undefined);
	assert.equal(sanitized.PI_COMS_SERVER, undefined);
	assert.equal(Object.keys(sanitized).some((key) => key.startsWith("PI_SUBAGENT_")), false);
});

await runTest("DSM candidate stays non-default and receives concise agent-aware dynamic prompts", async () => {
	const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	const raw = JSON.parse(fs.readFileSync(path.join(extensionDir, "phase-launches.json"), "utf8"));
	assert.equal(raw.defaultProfile, "default");
	const candidate = Object.fromEntries(Object.entries(raw.profiles["dsm-candidate"]).map(([phase, value]) => [phase, (Array.isArray(value) ? value : [value])])) as Record<RunnablePhase, any[]>;
	const expectedAgents: Record<RunnablePhase, string> = { IMPLEMENT: "dsm.implementer", VERIFY: "dsm.verifier", REVIEW: "dsm.reviewer", CLOSE: "dsm.closer", RETRO: "dsm.retrospective" };
	const configs = materializePhaseConfigs(candidate);
	assert.equal(candidate.REVIEW.length, 2);
	assert.deepEqual(Object.fromEntries((Object.keys(PHASE_CONTRACTS) as RunnablePhase[]).map((phase) => [phase, candidate[phase].map((launch) => launch.thinking)])), {
		IMPLEMENT: [undefined],
		VERIFY: [undefined],
		REVIEW: [undefined, undefined],
		CLOSE: [undefined],
		RETRO: [undefined],
	});
	for (const phase of Object.keys(PHASE_CONTRACTS) as RunnablePhase[]) {
		assert.ok(configs[phase].launches.every((launch) => launch.agent === expectedAgents[phase]));
		assert.ok(configs[phase].launches.every((launch) => launch.model === undefined), `${phase} must remain provider-neutral`);
		assert.ok(configs[phase].launches.every((launch) => launch.context === "fresh"));
		const context = { task: `dynamic ${phase} task`, artifactGuidance: "LEGACY ARTIFACT GUIDANCE", verifyRound: 2, maxRepairRounds: 3, pendingIssueInstruction: "repair this issue" };
		const dsmPrompt = configs[phase].childPrompt(context, expectedAgents[phase]);
		const compatibilityPrompt = configs[phase].childPrompt(context, raw.profiles.default[phase]?.agent ?? "reviewer");
		const crossPhasePrompt = configs[phase].childPrompt(context, expectedAgents[phase === "IMPLEMENT" ? "VERIFY" : "IMPLEMENT"]);
		const arbitraryDsmPrompt = configs[phase].childPrompt(context, "dsm.custom");
		assert.match(dsmPrompt, new RegExp(`Artifact contract for ${phase}`));
		assert.match(dsmPrompt, new RegExp(`dynamic ${phase} task`));
		assert.match(dsmPrompt, /LEGACY ARTIFACT GUIDANCE/);
		assert.doesNotMatch(dsmPrompt, /Instructions:/);
		for (const fullPrompt of [compatibilityPrompt, crossPhasePrompt, arbitraryDsmPrompt]) assert.match(fullPrompt, /Instructions:/);
	}

	process.env.PI_DELIVERY_PROFILE = "dsm-candidate";
	try {
		const harness = createHarness();
		const result = await harness.tool("delivery_start", { task: "candidate prompt smoke" });
		assert.equal(result.details.state.launchProfile.selectedProfile, "dsm-candidate");
		assert.equal(result.details.next.agent, "dsm.implementer");
		assert.match(result.details.next.childPrompt, /candidate prompt smoke/);
		assert.match(result.details.next.childPrompt, new RegExp(result.details.next.artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(result.details.next.childPrompt, /The Required checklist section must include/);
	} finally {
		delete process.env.PI_DELIVERY_PROFILE;
	}
});

await runTest("DSM dynamic prompts allow only runtime-owned contracts plus task/state context", async () => {
	process.env.PI_DELIVERY_PROFILE = "dsm-candidate";
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-dsm-prompt-allowlist-"));
		try {
			const harness = createHarness({ cwd });
			const task = "unique DSM dynamic task";
			let result = await harness.tool("delivery_start", { task });
			const forbiddenStablePolicy = [
				"Project harness discovery (bounded, best effort)",
				"Common workflow instruction:",
				"Instruction authority:",
				"Return your result and evidence to the parent/orchestrator",
				"do not recursively read unrelated documentation",
				"Implement the accepted task as the sole writer",
				"Independently verify the accepted task",
				"Independently review the current candidate",
				"Close the verified and reviewed delivery",
				"Write the read-only retrospective",
			];
			for (const phase of Object.keys(PHASE_CONTRACTS) as RunnablePhase[]) {
				const prompts = result.details.next.parallel?.map((launch: any) => launch.childPrompt) ?? [result.details.next.childPrompt];
				for (const prompt of prompts) {
					assert.match(prompt, new RegExp(`Artifact contract for ${phase}`));
					assert.match(prompt, /Project harness artifact contract:/);
					assert.match(prompt, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
					assert.match(prompt, new RegExp(task));
					for (const policy of forbiddenStablePolicy) assert.doesNotMatch(prompt, new RegExp(policy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${phase} leaked stable policy: ${policy}`);
				}
				if (phase === "RETRO") break;
				if (phase === "REVIEW") for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");
				result = await harness.tool("delivery_report", { phase, verdict: phase === "CLOSE" ? "DONE" : "PASS", summary: `${phase} passed` });
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	} finally {
		delete process.env.PI_DELIVERY_PROFILE;
	}
});

await runTest("cross-phase and arbitrary dsm names retain full compatibility prompts", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		mismatched: fullProfile({
			IMPLEMENT: { agent: "dsm.verifier" },
			VERIFY: { agent: "dsm.custom" },
		}),
	}), async () => {
		const harness = createHarness();
		let result = await harness.tool("delivery_start", { task: "exact DSM phase identity" });
		assert.equal(result.details.next.agent, "dsm.verifier");
		assert.match(result.details.next.childPrompt, /Implement this delivery phase as the sole writer/);
		assert.match(result.details.next.childPrompt, /Project harness discovery \(bounded, best effort\)/);
		assert.match(result.details.next.childPrompt, /Common workflow instruction:/);
		assert.match(result.details.next.childPrompt, /Instruction authority:/);
		assert.doesNotMatch(result.details.next.childPrompt, /Project harness artifact contract:/);

		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		assert.equal(result.details.next.agent, "dsm.custom");
		assert.match(result.details.next.childPrompt, /Independently verify this task/);
		assert.match(result.details.next.childPrompt, /Project harness discovery \(bounded, best effort\)/);
		assert.match(result.details.next.childPrompt, /Common workflow instruction:/);
		assert.match(result.details.next.childPrompt, /Instruction authority:/);
		assert.doesNotMatch(result.details.next.childPrompt, /Project harness artifact contract:/);
	});
});

await runTest("bundled agent thinking defaults avoid relay enforcement while explicit profile overrides remain enforced", async () => {
	process.env.PI_DELIVERY_PROFILE = "dsm-candidate";
	try {
		const harness = createHarness();
		await harness.tool("delivery_start", { task: "agent-owned thinking default" });
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		const next = await harness.tool("delivery_next");
		assert.equal(next.details.next.thinking, undefined);
		const launch = { agent: next.details.next.agent, output: next.details.next.output };
		assert.equal(await harness.emit("tool_call", { toolName: "subagent", input: launch }), undefined);
	} finally {
		delete process.env.PI_DELIVERY_PROFILE;
	}

	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		strict: fullProfile({
			REVIEW: [
				{ agent: "reviewer", thinking: "low" },
				{ agent: "reviewer", thinking: "high" },
			],
		}),
	}), async () => {
		const harness = createHarness();
		await advanceHarnessToPhase(harness, "REVIEW");
		const next = await harness.tool("delivery_next");
		const tasks = next.details.next.parallel.map((item: any) => ({ agent: item.agent, output: item.output, thinking: item.thinking }));
		assert.deepEqual(tasks.map((item: any) => item.thinking), ["low", "high"]);
		const missingSecond = tasks.map((item: any, index: number) => index === 1 ? { ...item, thinking: undefined } : item);
		assert.match((await harness.emit("tool_call", { toolName: "subagent", input: { tasks: missingSecond } }))?.reason, /pass thinking=high exactly.*received no thinking value/);

		assert.match((await harness.emit("tool_call", { toolName: "subagent", input: { tasks: tasks.slice(0, 1) } }))?.reason, /received 1 parallel task.*planned 2/i);

		const missingOutput = tasks.map((item: any, index: number) => index === 1 ? { agent: item.agent, thinking: item.thinking } : item);
		assert.match((await harness.emit("tool_call", { toolName: "subagent", input: { tasks: missingOutput } }))?.reason, /planned output path.*missing/i);

		const duplicateOutput = tasks.map((item: any, index: number) => index === 1 ? { ...item, output: tasks[0].output } : item);
		assert.match((await harness.emit("tool_call", { toolName: "subagent", input: { tasks: duplicateOutput } }))?.reason, /planned output path.*more than once/i);

		const unknownOutput = tasks.map((item: any, index: number) => index === 1 ? { ...item, output: `${item.output}.unknown` } : item);
		assert.match((await harness.emit("tool_call", { toolName: "subagent", input: { tasks: unknownOutput } }))?.reason, /does not match a planned parallel launch/i);

		assert.equal(await harness.emit("tool_call", { toolName: "subagent", input: { tasks: [...tasks].reverse() } }), undefined);
		assert.equal(await harness.emit("tool_call", { toolName: "subagent", input: { tasks } }), undefined);
	});
});

await runTest("phase launch prompts derive artifact contracts from the central source", async () => {
	const launches = Object.fromEntries(Object.keys(PHASE_CONTRACTS).map((phase) => [phase, [{ agent: "test" }]])) as Record<RunnablePhase, [{ agent: string }]>;
	const configs = materializePhaseConfigs(launches);
	for (const phase of Object.keys(PHASE_CONTRACTS) as RunnablePhase[]) {
		const task = `dynamic-${phase}-task`;
		const contract = phaseArtifactContractMarkdown(phase);
		const prompt = configs[phase].childPrompt({ task, artifactGuidance: "", verifyRound: 1, maxRepairRounds: 3, pendingIssueInstruction: "dynamic pending issue" });
		assert.ok(prompt.includes(contract));
		assert.ok(prompt.indexOf(contract) < prompt.indexOf(task), `${phase} contract must precede dynamic task context`);
		const builtIn = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "phases", `${phase.toLowerCase()}.md`), "utf8");
		assert.doesNotMatch(builtIn, /^Artifact contract for /m, `${phase} built-in prompt must not duplicate the generated contract`);
		const childTemplate = builtIn.split("## Child prompt", 2)[1] ?? "";
		assert.ok(childTemplate.indexOf("Instructions:") < childTemplate.indexOf("{{task}}"), `${phase} built-in static instructions must precede dynamic task context`);
	}
});

await runTest("default child prompts keep stable instructions ahead of run-specific context for prefix caching", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-prompt-prefix-"));
	try {
		const harness = createHarness({ cwd });
		const task = "unique dynamic cache boundary";
		let result = await harness.tool("delivery_start", { task });
		const phaseIntroductions: Record<RunnablePhase, string> = {
			IMPLEMENT: "Implement this delivery phase as the sole writer.",
			VERIFY: "Independently verify this task.",
			REVIEW: "Review the current diff for this task independently.",
			CLOSE: "Close this delivery.",
			RETRO: "Write a read-only retrospective for this delivery.",
		};
		for (const phase of Object.keys(PHASE_CONTRACTS) as RunnablePhase[]) {
			const prompts = result.details.next.parallel?.map((launch: any) => launch.childPrompt) ?? [result.details.next.childPrompt];
			for (const prompt of prompts) {
				const orderedMarkers = [
					"Project harness discovery (bounded, best effort)",
					"Common workflow instruction:",
					`Artifact contract for ${phase}`,
					phaseIntroductions[phase],
					task,
					"Artifact guidance:",
					`Project harness resolved root for this run: ${cwd}`,
					result.details.next.parallel ? "Parallel phase instruction:" : "Artifact contract:\n- Write your result to exactly this path:",
					"Instruction authority:",
				];
				let previous = -1;
				for (const marker of orderedMarkers) {
					const current = prompt.indexOf(marker);
					assert.ok(current > previous, `${phase}: expected prompt marker after previous content: ${marker}`);
					previous = current;
				}
			}
			if (phase === "RETRO") break;
			if (phase === "REVIEW") {
				for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");
			}
			const verdict = phase === "CLOSE" ? "DONE" : "PASS";
			result = await harness.tool("delivery_report", { phase, verdict, summary: `${phase} passed` });
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("review-scope prompts preserve broad discovery with bounded blocking", async () => {
	const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	const verifyPrompt = fs.readFileSync(path.join(extensionDir, "phases", "verify.md"), "utf8");
	const reviewPrompt = fs.readFileSync(path.join(extensionDir, "phases", "review.md"), "utf8");
	const deliverPrompt = fs.readFileSync(path.join(extensionDir, "prompts", "deliver.md"), "utf8");
	const indexSource = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8");

	for (const prompt of [verifyPrompt, reviewPrompt]) {
		assert.match(prompt, /accepted user task and explicit decisions/i);
		assert.match(prompt, /documented product or repository invariants/i);
		assert.match(prompt, /accepted implementation plan/i);
		assert.match(prompt, /supported operating and threat model/i);
		assert.match(prompt, /explicit exclusions/i);
		assert.match(prompt, /requirement or invariant violation[\s\S]*blocking/i);
		assert.match(prompt, /realistic regression in the supported workflow[\s\S]*blocking/i);
		assert.match(prompt, /unsupported\/adversarial scenario or optional hardening[\s\S]*non-blocking/i);
		assert.match(prompt, /contract change[\s\S]*parent\/user judgment/i);
		assert.match(prompt, /every must-fix finding must identify/i);
		assert.match(prompt, /exact accepted requirement or invariant violated/i);
		assert.match(prompt, /realistic reproducer inside the supported operating model/i);
		assert.match(prompt, /why existing safeguards and tests are insufficient/i);
		assert.match(prompt, /unsupported concurrency[\s\S]*non-blocking/i);
		assert.match(prompt, /realistic data loss within the supported workflow[\s\S]*blocking/i);
		assert.match(prompt, /missing plan item[\s\S]*higher-level accepted requirement or invariant[\s\S]*blocking/i);
	}

	assert.match(verifyPrompt, /`Must-fix findings`, `Non-blocking concerns \/ hardening`, and `Decisions needed`/i);
	assert.match(reviewPrompt, /put a `Decisions needed` label in the Summary/i);

	const reviewOrchestrator = reviewPrompt.match(/## Orchestrator instruction\n\n([\s\S]*?)\n\n## Child prompt/)?.[1];
	assert.ok(reviewOrchestrator, "review prompt includes orchestrator guidance");
	assert.match(reviewOrchestrator, /do not blindly trust .*must-fix label/i);
	assert.match(reviewOrchestrator, /only when .*supported must-fix finding[\s\S]*exact accepted requirement or invariant[\s\S]*realistic reproducer[\s\S]*safeguards and tests/i);
	assert.match(reviewOrchestrator, /unsupported\/adversarial[\s\S]*non-blocking/i);
	assert.match(reviewOrchestrator, /contract question[\s\S]*parent\/user judgment/i);
	assert.doesNotMatch(reviewOrchestrator, /if any reviewer finds a must-fix issue/i);

	for (const parentGuidance of [deliverPrompt, indexSource]) {
		assert.match(parentGuidance, /auto-repair only/i);
		assert.match(parentGuidance, /do not blindly trust (?:a )?verdict label/i);
		assert.match(parentGuidance, /new product, safety, concurrency, or threat-model contract/i);
		assert.match(parentGuidance, /spawn exhaustion/i);
		assert.match(parentGuidance, /do not report PASS/i);
		assert.match(parentGuidance, /do not report PASS (?:or|and do not) substitute parent self-verification/i);
		assert.match(parentGuidance, /new Pi session is required/i);
	}
});

await runTest("every runnable child prompt includes bounded project harness discovery from the resolved root", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-harness-root-"));
	try {
		const harness = createHarness({ cwd });
		let result = await harness.tool("delivery_start", { task: "artifact guidance smoke" });
		for (const phase of ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"]) {
			const prompts = result.details.next.parallel?.map((launch: any) => launch.childPrompt) ?? [result.details.next.childPrompt];
			for (const prompt of prompts) {
				assert.match(prompt, /Project harness discovery \(bounded, best effort\)/);
				assert.match(prompt, new RegExp(`Project harness resolved root for this run: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
				assert.match(prompt, /none discovered/);
				assert.match(prompt, /do not recursively read unrelated documentation/);
				assert.doesNotMatch(prompt, /docs\/index\.md/);
			}
			if (phase === "RETRO") break;
			if (phase === "REVIEW") {
				for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");
			}
			const verdict = phase === "CLOSE" ? "DONE" : "PASS";
			result = await harness.tool("delivery_report", { phase, verdict, summary: `${phase} passed` });
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("delivery child prompts include central RESULT artifact guidance", async () => {
	const harness = createHarness();
	const result = await harness.tool("delivery_start", { task: "artifact guidance smoke" });
	assert.equal(result.details.next.acceptance, false);
	assert.match(result.details.next.childPrompt, /Start the artifact with exactly one result line: RESULT:/);
	assert.match(result.details.next.childPrompt, /Use the phase-specific headings/);
});

await runTest("single-child next actions expose exact file-only output fields", async () => {
	const harness = createHarness();
	const result = await harness.tool("delivery_start", { task: "single child output contract" });
	const action = result.details.next;
	assert.equal(action.artifact, action.output);
	assert.equal(action.outputMode, "file-only");
	assert.match(action.artifact, /01-implementation\.md$/);
	assert.match(action.childPrompt, new RegExp(action.artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

await runTest("planning may use the stable primary checkout but implementation requires a fresh main worktree", async () => {
	const harness = createHarness();
	const deliver = harness.commands.get("deliver");
	assert.ok(deliver, "deliver command should be registered");
	await deliver.handler("planning worktree policy smoke", harness.ctx);
	const result = await harness.tool("delivery_next");
	const bootstrapPrompt = harness.sentMessages.at(-1) ?? "";
	const orchestratorInstruction = result.details.next.orchestratorInstruction;
	const toolGuidelines = harness.tools.get("delivery_start")?.promptGuidelines?.join(" ") ?? "";

	for (const policySurface of [bootstrapPrompt, orchestratorInstruction, toolGuidelines]) {
		assert.match(policySurface, /planning-only MR on a (?:`plan\/<slug>`|plan\/<slug>) branch may be created and submitted directly from the stable primary checkout/i);
		assert.match(policySurface, /latest fetched (?:`main`|main)/i);
		assert.match(policySurface, /never from the planning branch/i);
	}
});

await runTest("reports reject wrong, duplicate, missing, and phase-invalid verdicts without side effects", async () => {
	const wrongPhase = createHarness();
	await wrongPhase.tool("delivery_start", { task: "wrong phase regression" });
	await assertReportRejectedAndInert(wrongPhase, { phase: "VERIFY", verdict: "PASS", summary: "out of order" }, /current phase is IMPLEMENT|expected IMPLEMENT/i);

	for (const verdict of [undefined, "PASS_WITH_NON_BLOCKING_NOTES", "INCONCLUSIVE", "DONE", "MR_CREATED"]) {
		const harness = createHarness();
		await harness.tool("delivery_start", { task: `invalid implement verdict ${String(verdict)}` });
		await assertReportRejectedAndInert(
			harness,
			{ phase: "IMPLEMENT", ...(verdict === undefined ? {} : { verdict }), summary: "invalid verdict" },
			/verdict|required|not valid|not allowed/i,
		);
	}

	const duplicate = createHarness();
	await duplicate.tool("delivery_start", { task: "duplicate report regression" });
	await duplicate.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await assertReportRejectedAndInert(duplicate, { phase: "IMPLEMENT", verdict: "PASS", summary: "duplicate" }, /current phase is VERIFY|already reported|duplicate/i);
});

await runTest("reports are rejected in waiting and terminal states without side effects", async () => {
	const waiting = createHarness();
	await waiting.tool("delivery_start", { task: "waiting report rejection" });
	await waiting.tool("delivery_report", { phase: "IMPLEMENT", verdict: "FAIL", summary: "blocked" });
	await assertReportRejectedAndInert(waiting, { phase: "IMPLEMENT", verdict: "FAIL", summary: "duplicate while waiting" }, /not in an active runnable phase|WAITING_DECISION/i);

	const stopped = createHarness();
	await stopped.tool("delivery_start", { task: "stopped report rejection" });
	await stopped.tool("delivery_report", { phase: "IMPLEMENT", verdict: "FAIL", summary: "blocked" });
	await stopped.tool("delivery_decide", { decision: "stop", rationale: "stop requested" });
	await assertReportRejectedAndInert(stopped, { phase: "IMPLEMENT", verdict: "PASS", summary: "after stop" }, /not in an active runnable phase|STOPPED/i);

	const done = createHarness();
	await advanceHarnessToPhase(done, "DONE");
	await assertReportRejectedAndInert(done, { phase: "RETRO", verdict: "DONE", summary: "duplicate after done" }, /not in an active runnable phase|DONE/i);
});

await runTest("every runnable phase enforces its complete verdict matrix", async () => {
	const allVerdicts = [...new Set(Object.values(PHASE_CONTRACTS).flatMap((contract) => contract.allowedVerdicts))];
	for (const phase of Object.keys(PHASE_CONTRACTS) as RunnablePhase[]) {
		const allowed = PHASE_CONTRACTS[phase].allowedVerdicts;
		const invalidHarness = createHarness();
		await advanceHarnessToPhase(invalidHarness, phase);
		for (const verdict of allVerdicts.filter((candidate) => !allowed.includes(candidate))) {
			await assertReportRejectedAndInert(
				invalidHarness,
				{ phase, verdict, summary: `${verdict} is invalid for ${phase}` },
				new RegExp(`verdict ${verdict} is not valid.*allowed verdicts`, "i"),
			);
		}

		for (const verdict of allowed) {
			const validHarness = createHarness();
			await advanceHarnessToPhase(validHarness, phase);
			if (phase === "REVIEW") {
				const reviewNext = await validHarness.tool("delivery_next");
				const childVerdict = verdict === "PASS_WITH_NON_BLOCKING_NOTES" ? verdict : "PASS";
				for (const launch of reviewNext.details.next.parallel) writeReviewArtifact(launch.artifact, childVerdict, "matrix review");
			}
			await validHarness.tool("delivery_report", { phase, verdict, summary: `${phase} accepts ${verdict}` });
		}
	}
});

await runTest("IMPLEMENT FAIL waits for an explicit decision instead of advancing", async () => {
	const harness = createHarness();
	await harness.tool("delivery_start", { task: "implementation failure regression" });
	const result = await harness.tool("delivery_report", {
		phase: "IMPLEMENT",
		verdict: "FAIL",
		summary: "implementation is incomplete",
	});
	assert.equal(result.details.state.phase, "WAITING_DECISION");
	assert.equal(result.details.state.pendingIssue.source, "implement");
	assert.equal(result.details.state.pendingIssue.verdict, "FAIL");
});

await runTest("decision prompts expose only repair, accept_risk, and stop", async () => {
	const harness = createHarness();
	await harness.tool("delivery_start", { task: "decision menu regression", maxRounds: { VERIFY: 1 } });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	const failed = await harness.tool("delivery_report", {
		phase: "VERIFY",
		verdict: "FAIL",
		summary: "verification failed",
		recommendedDecision: "repair",
	});
	assert.equal(failed.details.state.phase, "WAITING_DECISION");
	assert.match(failed.details.next.prompt, /repair \/ accept_risk \/ stop/);
	assert.doesNotMatch(failed.details.next.prompt, /continue|defer/);
});

await runTest("artifact-less FAIL and INCONCLUSIVE non-parallel reports are rejected without side effects", async () => {
	const cases = [
		{ phase: "IMPLEMENT" as const, verdict: "FAIL" as const },
		{ phase: "VERIFY" as const, verdict: "INCONCLUSIVE" as const },
		{ phase: "CLOSE" as const, verdict: "FAIL" as const },
	];
	for (const { phase, verdict } of cases) {
		const harness = createHarness();
		await advanceHarnessToPhase(harness, phase);
		await assertReportRejectedAndInert(
			harness,
			{ phase, verdict, summary: `${phase} omitted its required ${verdict} artifact` },
			new RegExp(`Cannot report ${phase}: missing planned artifact path|missing artifact path`),
		);
	}
});

await runTest("artifact-less successful non-parallel reports are rejected across phases", async () => {
	const harness = createHarness();
	let result = await harness.tool("delivery_start", { task: "artifact required across phases" });
	for (const phase of ["IMPLEMENT", "VERIFY", "CLOSE", "RETRO"] as const) {
		if (phase === "CLOSE") {
			for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");
			result = await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "review passed" });
		}
		const verdict = phase === "CLOSE" || phase === "RETRO" ? "DONE" : "PASS";
		await assert.rejects(
			() => harness.tool("delivery_report", { phase, verdict, summary: `${phase} omitted its artifact`, __omitArtifact: true }),
			new RegExp(`Cannot report (?:successful )?${phase}: missing (?:planned )?artifact path`),
		);
		const artifact = result.details.next.artifact as string;
		fs.writeFileSync(artifact, phaseArtifactContents(phase, verdict, `${phase} passed`), "utf8");
		result = await harness.tool("delivery_report", { phase, verdict, summary: `${phase} passed`, artifact });
	}
});

await runTest("new phase artifacts enforce exact regular contained planned paths and required headings", async () => {
	const validImplement = (verdict = "PASS") => `RESULT: ${verdict}\n\n## Summary\nimplemented\n\n## Required checklist\n- complete\n\n## Changed files\n- none\n\n## Tests added or updated\n- none\n\n## Commands run\n- none\n\n## Evidence\n- evidence\n\n## Residual risks\nnone\n\n## Recommendation\nnone\n\n${projectHarnessEvidence("none discovered")}\n`;

	const cases: Array<{ name: string; prepare: (planned: string, artifactDir: string) => string }> = [
		{
			name: "wrong path",
			prepare: (_planned, artifactDir) => {
				const alternate = path.join(artifactDir, "alternate.md");
				fs.writeFileSync(alternate, validImplement(), "utf8");
				return alternate;
			},
		},
		{
			name: "empty file",
			prepare: (planned) => (fs.writeFileSync(planned, "", "utf8"), planned),
		},
		{
			name: "directory",
			prepare: (planned) => (fs.mkdirSync(planned), planned),
		},
		{
			name: "semicolon alternate list",
			prepare: (planned, artifactDir) => {
				fs.writeFileSync(planned, validImplement(), "utf8");
				const alternate = path.join(artifactDir, "second.md");
				fs.writeFileSync(alternate, validImplement(), "utf8");
				return `${planned}; ${alternate}`;
			},
		},
		{
			name: "missing required heading",
			prepare: (planned) => (fs.writeFileSync(planned, `RESULT: PASS\n\n## Summary\nincomplete\n\n${projectHarnessEvidence("none discovered")}`, "utf8"), planned),
		},
	];

	for (const testCase of cases) {
		const harness = createHarness();
		const started = await harness.tool("delivery_start", { task: `artifact contract ${testCase.name}` });
		const planned = started.details.next.artifact as string;
		const artifact = testCase.prepare(planned, started.details.state.artifactDir);
		await assert.rejects(
			() => harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: testCase.name, artifact }),
			/path|regular file|empty|required heading|planned artifact|file does not exist/i,
		);
	}

	const symlinkHarness = createHarness();
	const started = await symlinkHarness.tool("delivery_start", { task: "artifact symlink escape" });
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-artifact-outside-"));
	try {
		const outside = path.join(outsideDir, "outside.md");
		fs.writeFileSync(outside, validImplement(), "utf8");
		fs.symlinkSync(outside, started.details.next.artifact);
		await assert.rejects(
			() => symlinkHarness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "symlink", artifact: started.details.next.artifact }),
			/symlink|escape|contained|regular file/i,
		);
	} finally {
		fs.rmSync(outsideDir, { recursive: true, force: true });
	}
});

await runTest("successful new artifacts require complete section-bounded harness evidence", async () => {
	const invalidCases = [
		"RESULT: PASS\n\n## Summary\nmissing harness\n",
		`RESULT: PASS\n\n## Project harness discovery and compliance\n- Outcome: applied\n\n## Evidence\n${projectHarnessEvidence("applied")}`,
		`RESULT: PASS\n\n${projectHarnessEvidence("applied").replace("- Entry points discovered: none", "- Entry points discovered:   ")}`,
		`RESULT: PASS\n\n${projectHarnessEvidence("applied").replace("- Mandatory references followed: none\n", "")}`,
	];
	for (const [index, contents] of invalidCases.entries()) {
		const harness = createHarness();
		const started = await harness.tool("delivery_start", { task: `invalid harness artifact ${index}` });
		const artifact = started.details.next.artifact as string;
		fs.writeFileSync(artifact, contents, "utf8");
		await assert.rejects(
			() => harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "invalid", artifact }),
			/lacks a valid Project harness discovery and compliance section/,
		);
	}
});

await runTest("successful IMPLEMENT and VERIFY reports reject blocked harness outcomes", async () => {
	const harness = createHarness();
	const started = await harness.tool("delivery_start", { task: "phase-specific blocked harness validation" });
	const artifact = started.details.next.artifact as string;
	fs.writeFileSync(artifact, phaseArtifactContents("IMPLEMENT", "PASS", "blocked").replace("Outcome: none discovered", "Outcome: blocked"), "utf8");
	await assert.rejects(
		() => harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "blocked", artifact }),
		/project harness outcome is blocked/,
	);
	fs.writeFileSync(artifact, phaseArtifactContents("IMPLEMENT", "PASS", "valid"), "utf8");
	let result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "valid", artifact });
	assert.equal(result.details.state.phase, "VERIFY");
	const verifyArtifact = result.details.next.artifact as string;
	fs.writeFileSync(verifyArtifact, phaseArtifactContents("VERIFY", "PASS", "blocked").replace("Outcome: none discovered", "Outcome: blocked"), "utf8");
	await assert.rejects(
		() => harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "blocked", artifact: verifyArtifact }),
		/project harness outcome is blocked/,
	);
});

await runTest("pre-existing parallel aggregate harness status is regenerated from child evidence", async () => {
	const harness = createHarness();
	let result = await harness.tool("delivery_start", { task: "regenerate caller-controlled aggregate" });
	result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");

	const aggregate = path.join(result.details.state.artifactDir as string, "03-review.md");
	fs.writeFileSync(aggregate, `RESULT: PASS\n\n## Summary\ncaller-controlled contradiction\n\n${projectHarnessEvidence("blocked")}`, "utf8");
	result = await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "validated children", artifact: aggregate });

	const regenerated = fs.readFileSync(aggregate, "utf8");
	assert.match(regenerated, /## Summary\nvalidated children/);
	assert.doesNotMatch(regenerated, /- Compliance status:/);
	assert.match(regenerated, /- Outcome: none discovered/);
	assert.doesNotMatch(regenerated, /caller-controlled contradiction/);
	assert.equal(result.details.state.phase, "CLOSE");
});

await runTest("unsuccessful parallel artifacts require harness evidence before aggregate generation", async () => {
	const harness = createHarness();
	let result = await harness.tool("delivery_start", { task: "failed parallel review harness evidence" });
	result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	const [missingEvidence, validEvidence] = result.details.next.parallel;
	fs.writeFileSync(missingEvidence.artifact, phaseArtifactContents("REVIEW", "FAIL", "review failure").replace(/\n\n## Project harness discovery[\s\S]*$/, "\n"), "utf8");
	writeReviewArtifact(validEvidence.artifact, "PASS", "review passed");
	const aggregate = path.join(result.details.state.artifactDir as string, "03-review.md");
	await assert.rejects(
		() => harness.tool("delivery_report", { phase: "REVIEW", verdict: "FAIL", summary: "must repair", recommendedDecision: "repair" }),
		/lacks a valid Project harness discovery and compliance section\/outcome/,
	);
	assert.equal(fs.existsSync(aggregate), false, "missing child harness evidence must not be synthesized as Outcome: applied");
	assert.equal((await harness.tool("delivery_status")).details.state.phase, "REVIEW");
});

await runTest("successful single-phase report rejects a failing artifact RESULT", async () => {
	const harness = createHarness();
	const started = await harness.tool("delivery_start", { task: "single artifact verdict consistency" });
	const artifact = started.details.next.artifact as string;
	fs.writeFileSync(artifact, phaseArtifactContents("IMPLEMENT", "FAIL", "failing result"), "utf8");
	await assert.rejects(
		() => harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "claimed success", artifact }),
		/artifact RESULT is FAIL/,
	);
	assert.equal((await harness.tool("delivery_status")).details.state.phase, "IMPLEMENT");
});

await runTest("parallel review rejects PASS when any child RESULT fails without generating a PASS aggregate", async () => {
	const harness = createHarness();
	let result = await harness.tool("delivery_start", { task: "parallel child verdict consistency" });
	result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	writeReviewArtifact(result.details.next.parallel[0].artifact, "FAIL", "review blocker");
	writeReviewArtifact(result.details.next.parallel[1].artifact, "PASS", "no blocker");
	const aggregate = path.join(result.details.state.artifactDir as string, "03-review.md");
	await assert.rejects(
		() => harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "incorrect aggregate" }),
		/child RESULT verdicts require aggregate verdict FAIL/,
	);
	assert.equal(fs.existsSync(aggregate), false);
	assert.equal((await harness.tool("delivery_status")).details.state.phase, "REVIEW");
});

await runTest("parallel VERIFY rejects a parent verdict more optimistic than its children", async () => {
	const launchConfig = JSON.stringify({
		defaultProfile: "default",
		profiles: {
			default: {
				IMPLEMENT: { agent: "worker" },
				VERIFY: [{ agent: "verifier-a" }, { agent: "verifier-b" }],
				REVIEW: [{ agent: "reviewer-a" }, { agent: "reviewer-b" }],
				CLOSE: { agent: "closer" },
				RETRO: { agent: "retro" },
			},
		},
	});
	await withTemporaryUserExtensionFile("phase-launches.json", launchConfig, async () => {
		const harness = createHarness();
		let result = await harness.tool("delivery_start", { task: "parallel verify verdict dominance" });
		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		const verifySteps = result.details.next.parallel;
		fs.writeFileSync(verifySteps[0].artifact, phaseArtifactContents("VERIFY", "FAIL", "verification failed"), "utf8");
		fs.writeFileSync(verifySteps[1].artifact, phaseArtifactContents("VERIFY", "PASS", "verification passed"), "utf8");
		await assertReportRejectedAndInert(
			harness,
			{ phase: "VERIFY", verdict: "PASS", summary: "incorrect optimistic aggregate" },
			/child RESULT verdicts require aggregate verdict FAIL/i,
		);
	});
});

await runTest("parallel aggregate verdict may be conservative but never more optimistic", async () => {
	const optimistic = createHarness();
	let result = await optimistic.tool("delivery_start", { task: "aggregate notes dominance" });
	await optimistic.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await optimistic.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	result = await optimistic.tool("delivery_next");
	writeReviewArtifact(result.details.next.parallel[0].artifact, "PASS_WITH_NON_BLOCKING_NOTES", "review notes");
	writeReviewArtifact(result.details.next.parallel[1].artifact, "PASS", "review passed");
	await assert.rejects(
		() => optimistic.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "too optimistic" }),
		/child RESULT verdicts require aggregate verdict PASS_WITH_NON_BLOCKING_NOTES|more optimistic/i,
	);

	const conservative = createHarness();
	result = await conservative.tool("delivery_start", { task: "conservative aggregate" });
	await conservative.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await conservative.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	result = await conservative.tool("delivery_next");
	for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "review passed");
	result = await conservative.tool("delivery_report", { phase: "REVIEW", verdict: "FAIL", summary: "parent found supported blocker" });
	assert.equal(result.details.state.phase, "WAITING_DECISION");
});

await runTest("parallel review rejects phase-unsupported child RESULT verdicts", async () => {
	for (const unsupported of ["INCONCLUSIVE", "DONE", "MR_CREATED"]) {
		const harness = createHarness();
		let result = await harness.tool("delivery_start", { task: `unsupported review verdict ${unsupported}` });
		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		fs.writeFileSync(result.details.next.parallel[0].artifact, phaseArtifactContents("REVIEW", unsupported, "unsupported review result"), "utf8");
		writeReviewArtifact(result.details.next.parallel[1].artifact, "PASS", "review passed");
		await assert.rejects(
			() => harness.tool("delivery_report", { phase: "REVIEW", verdict: "FAIL", summary: "must not guess" }),
			new RegExp(`child RESULT verdict ${unsupported} is not valid for REVIEW`),
		);
		assert.equal((await harness.tool("delivery_status")).details.state.phase, "REVIEW");
	}
});

await runTest("supplied single-artifact RESULT must equal FAIL and INCONCLUSIVE report verdicts", async () => {
	const failHarness = createHarness();
	const failStarted = await failHarness.tool("delivery_start", { task: "failed verdict equality" });
	const failArtifact = failStarted.details.next.artifact as string;
	fs.writeFileSync(failArtifact, phaseArtifactContents("IMPLEMENT", "PASS", "contradictory result"), "utf8");
	await assert.rejects(
		() => failHarness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "FAIL", summary: "claimed failure", artifact: failArtifact }),
		/Cannot report IMPLEMENT with verdict FAIL: artifact RESULT is PASS/,
	);

	const verifyHarness = createHarness();
	let result = await verifyHarness.tool("delivery_start", { task: "inconclusive verdict equality" });
	result = await verifyHarness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	const verifyArtifact = result.details.next.artifact as string;
	fs.writeFileSync(verifyArtifact, phaseArtifactContents("VERIFY", "FAIL", "contradictory result"), "utf8");
	await assert.rejects(
		() => verifyHarness.tool("delivery_report", { phase: "VERIFY", verdict: "INCONCLUSIVE", summary: "claimed inconclusive", artifact: verifyArtifact }),
		/Cannot report VERIFY with verdict INCONCLUSIVE: artifact RESULT is FAIL/,
	);

	// Strict validation applies to every newly submitted artifact, including an
	// unsuccessful report; legacy artifacts remain readable outside submission.
	fs.writeFileSync(verifyArtifact, phaseArtifactContents("VERIFY", "INCONCLUSIVE", "missing harness evidence").replace(/\n\n## Project harness discovery[\s\S]*$/, "\n"), "utf8");
	await assert.rejects(
		() => verifyHarness.tool("delivery_report", { phase: "VERIFY", verdict: "INCONCLUSIVE", summary: "missing harness evidence", artifact: verifyArtifact }),
		/lacks a valid Project harness discovery and compliance section\/outcome/,
	);
});

await runTest("delivery usage accounting uses the shared parser and token fallback", async () => {
	const totals = collectUsageFromJsonlContent(`${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 4, output: 6, cost: { total: 0.01 } } } })}\nnot-json\n`, { countSessionFile: true });
	assert.equal(totals.totalTokens, 10);
	assert.equal(totals.cost, 0.01);
	assert.equal(totals.assistantMessages, 1);
	assert.equal(totals.sessionFiles, 1);
});

await runTest("delivery usage accounting discovers subagent sessions and subtracts deltas", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-usage-shared-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		const child = path.join(dir, "parent", "run-1", "run-0", "session.jsonl");
		fs.writeFileSync(parent, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } } })}\n`, "utf8");
		fs.mkdirSync(path.dirname(child), { recursive: true });
		fs.writeFileSync(child, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 2, output: 3, total: 9 } } })}\n`, "utf8");

		const usage = collectSessionUsage(parent, { childFileName: "session.jsonl" });
		assert.equal(usage.total.totalTokens, 24);
		assert.equal(usage.total.sessionFiles, 2);
		assert.equal(usage.rows[1].runId, "run-1");
		assert.deepEqual(subtractUsageTotals(usage.total, { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0, assistantMessages: 1, sessionFiles: 1 }), {
			input: 2,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: 0,
			assistantMessages: 1,
			sessionFiles: 1,
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("/deliver reaches review with exactly the configured parallel reviewers", async () => {
	const harness = createHarness();
	const deliver = harness.commands.get("deliver");
	assert.ok(deliver, "deliver command should be registered");

	await deliver.handler("simple parallel review smoke", harness.ctx);
	assert.match(harness.sentMessages[0], /Run the delivery state machine for this task:/);

	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "smoke implementation pass" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "smoke verification pass" });
	const next = await harness.tool("delivery_next");

	const action = next.details.next;
	assert.equal(action.phase, "REVIEW");
	assert.equal(action.parallel.length, 2);
	assert.equal(action.parallel[0].agent, "reviewer");
	assert.equal(action.parallel[0].model, undefined);
	assert.equal(action.parallel[0].acceptance, false);
	assert.match(action.parallel[0].childPrompt, /03-review-1-01-reviewer\.md/);
	assert.match(action.parallel[0].artifact, /03-review-1-01-reviewer\.md/);
	assert.equal(action.parallel[0].output, action.parallel[0].artifact);
	assert.equal(action.parallel[0].outputMode, "file-only");
	assert.equal(action.parallel[1].agent, "reviewer");
	assert.equal(action.parallel[1].model, "openai/gpt-5.5");
	assert.equal(action.parallel[1].acceptance, false);
	assert.match(action.parallel[1].childPrompt, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(action.parallel[1].artifact, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.equal(action.parallel[1].output, action.parallel[1].artifact);
	assert.equal(action.parallel[1].outputMode, "file-only");
	assert.match(action.reportInstruction, /After all 2 children complete/);
	assert.match(action.reportInstruction, /confirms every details\.next\.parallel\[\]\.artifact file exists/);
	assert.match(action.reportInstruction, /delivery_report will reject parallel phase reports/);
	assert.match(action.reportInstruction, /omit artifact or provide only the exact planned aggregate path/);
});

function profileLaunches(profiles: Record<string, Record<string, unknown>>, defaultProfile = Object.keys(profiles)[0]): string {
	return JSON.stringify({ defaultProfile, profiles });
}

function fullProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		IMPLEMENT: { agent: "worker", model: "profile/implement" },
		VERIFY: { agent: "fresh-verifier", model: "profile/verify", thinking: "low", context: "fresh" },
		REVIEW: [
			{ agent: "reviewer", model: "profile/review-a" },
			{ agent: "reviewer", model: "profile/review-b" },
		],
		CLOSE: { agent: "delegate", model: "profile/close", thinking: "low" },
		RETRO: { agent: "delegate", model: "profile/retro", thinking: "high" },
		...overrides,
	};
}

await runTest("global profile config can force GPT-only models", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		"gpt-only": fullProfile({
			IMPLEMENT: { agent: "worker", model: "openai/gpt-5.5" },
			VERIFY: { agent: "fresh-verifier", model: "openai/gpt-5.5", thinking: "low", context: "fresh" },
			REVIEW: [
				{ agent: "reviewer", model: "openai/gpt-5.5" },
				{ agent: "reviewer", model: "openai/gpt-5.5" },
			],
			CLOSE: { agent: "delegate", model: "openai/gpt-5.5", thinking: "low" },
			RETRO: { agent: "delegate", model: "openai/gpt-5.5", thinking: "high" },
		}),
	}), async () => {
		const harness = createHarness();
		await harness.tool("delivery_start", { task: "gpt-only launch override smoke" });
		let next = await harness.tool("delivery_next");
		assert.equal(next.details.next.model, "openai/gpt-5.5");
		assert.equal(next.details.state.launchProfile.selectedProfile, "gpt-only");

		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		next = await harness.tool("delivery_next");
		assert.deepEqual(next.details.next.parallel.map((launch: any) => launch.model), ["openai/gpt-5.5", "openai/gpt-5.5"]);
	});
});

await runTest("global profile config trims profile names consistently", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		" premium ": fullProfile({ IMPLEMENT: { agent: "worker", model: "trimmed/model" } }),
	}, " premium "), async () => {
		const harness = createHarness();
		const result = await harness.tool("delivery_start", { task: "trimmed profile smoke" });
		assert.equal(result.details.next.model, "trimmed/model");
		assert.equal(result.details.state.launchProfile.selectedProfile, "premium");
		assert.equal(result.details.state.launchProfile.source, "global-default-profile");
	});
});

await runTest("active profile and env override select global profiles", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		cheap: fullProfile({ IMPLEMENT: { agent: "worker", model: "cheap/model" } }),
		premium: fullProfile({ IMPLEMENT: { agent: "worker", model: "premium/model" } }),
	}, "cheap"), async () => {
		await withTemporaryUserExtensionFile("active-profile.json", JSON.stringify({ activeProfile: "premium" }), async () => {
			let harness = createHarness();
			let result = await harness.tool("delivery_start", { task: "active profile smoke" });
			assert.equal(result.details.next.model, "premium/model");
			assert.equal(result.details.state.launchProfile.source, "global-active-profile");

			process.env.PI_DELIVERY_PROFILE = "cheap";
			try {
				harness = createHarness();
				result = await harness.tool("delivery_start", { task: "env profile smoke" });
				assert.equal(result.details.next.model, "cheap/model");
				assert.equal(result.details.state.launchProfile.source, "env");
				assert.equal(result.details.state.launchProfile.envOverride, true);
			} finally {
				delete process.env.PI_DELIVERY_PROFILE;
			}
		});
	});
});

await runTest("delivery run pins profile selected at start", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		alpha: fullProfile({ IMPLEMENT: { agent: "worker", model: "alpha/implement" }, VERIFY: { agent: "fresh-verifier", model: "alpha/verify", thinking: "low", context: "fresh" } }),
		beta: fullProfile({ IMPLEMENT: { agent: "worker", model: "beta/implement" }, VERIFY: { agent: "fresh-verifier", model: "beta/verify", thinking: "low", context: "fresh" } }),
	}, "alpha"), async () => {
		const harness = createHarness();
		const started = await harness.tool("delivery_start", { task: "profile pinning smoke" });
		assert.equal(started.details.next.model, "alpha/implement");

		await withTemporaryUserExtensionFile("active-profile.json", JSON.stringify({ activeProfile: "beta" }), async () => {
			await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
			const next = await harness.tool("delivery_next");
			assert.equal(next.details.next.phase, "VERIFY");
			assert.equal(next.details.next.model, "alpha/verify");
			assert.equal(next.details.state.launchProfile.selectedProfile, "alpha");
		});
	});
});

await runTest("user phase prompt override wins and project prompt override is ignored", async () => {
	await withTemporaryUserExtensionFile("phases/verify.md", `---\nphase: VERIFY\n---\n\n## Child prompt\n\nUSER VERIFY PROMPT {{task}}\n`, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-prompt-"));
		try {
			const projectPhasesDir = path.join(cwd, ".pi", "delivery-state-machine", "phases");
			fs.mkdirSync(projectPhasesDir, { recursive: true });
			fs.writeFileSync(path.join(projectPhasesDir, "verify.md"), `---\nphase: VERIFY\n---\n\n## Child prompt\n\nPROJECT VERIFY PROMPT {{task}}\n`, "utf8");

			const harness = createHarness({ cwd });
			await harness.tool("delivery_start", { task: "prompt override smoke" });
			await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
			const next = await harness.tool("delivery_next");

			assert.match(next.details.next.childPrompt, /USER VERIFY PROMPT prompt override smoke/);
			assert.match(next.details.next.childPrompt, /Project harness discovery \(bounded, best effort\)/);
			assert.doesNotMatch(next.details.next.childPrompt, /PROJECT VERIFY PROMPT/);
			assert.match(next.details.next.orchestratorInstruction, /Launch the configured verifier/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

await runTest("project launch override is ignored in favor of global profile config", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", profileLaunches({
		global: fullProfile({ IMPLEMENT: { agent: "worker", model: "global/model" } }),
	}), async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-launch-"));
		try {
			const projectConfigDir = path.join(cwd, ".pi", "delivery-state-machine");
			fs.mkdirSync(projectConfigDir, { recursive: true });
			fs.writeFileSync(path.join(projectConfigDir, "phase-launches.json"), JSON.stringify({
				IMPLEMENT: { agent: "worker", model: "project/model" },
			}), "utf8");

			const harness = createHarness({ cwd });
			const result = await harness.tool("delivery_start", { task: "launch precedence smoke" });
			assert.equal(result.details.next.model, "global/model");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

await runTest("project prompt and launch overrides are ignored when cwd is a git subdirectory", async () => {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-git-root-"));
	try {
		execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
		const cwd = path.join(repoRoot, "packages", "app");
		fs.mkdirSync(cwd, { recursive: true });
		const projectConfigDir = path.join(repoRoot, ".pi", "delivery-state-machine");
		fs.mkdirSync(path.join(projectConfigDir, "phases"), { recursive: true });
		fs.writeFileSync(path.join(projectConfigDir, "phase-launches.json"), JSON.stringify({
			IMPLEMENT: { agent: "worker", model: "repo-root/model" },
		}), "utf8");
		fs.writeFileSync(path.join(projectConfigDir, "phases", "verify.md"), `---\nphase: VERIFY\n---\n\n## Child prompt\n\nREPO ROOT VERIFY PROMPT {{task}}\n`, "utf8");

		const harness = createHarness({ cwd });
		let result = await harness.tool("delivery_start", { task: "subdirectory override smoke" });
		assert.equal(result.details.state.gitRoot, fs.realpathSync(repoRoot));
		assert.notEqual(result.details.next.model, "repo-root/model");

		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		result = await harness.tool("delivery_next");
		assert.doesNotMatch(result.details.next.childPrompt, /REPO ROOT VERIFY PROMPT/);
	} finally {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	}
});

await runTest("phase markdown launch fields are rejected for user prompt overrides", async () => {
	await withTemporaryUserExtensionFile("phases/implement.md", `---\nphase: IMPLEMENT\nmodel: openai/gpt-5.5\n---\n`, async () => {
		const harness = createHarness();
		await assert.rejects(() => harness.tool("delivery_start", { task: "invalid phase frontmatter smoke" }), /must not declare model/);
	});
});

await runTest("parallel launch configuration follows central phase eligibility", async () => {
	for (const phase of (Object.keys(PHASE_CONTRACTS) as RunnablePhase[]).filter((candidate) => !PHASE_CONTRACTS[candidate].parallelEligible)) {
		const launches: Record<string, unknown> = {
			IMPLEMENT: { agent: "worker" },
			VERIFY: { agent: "fresh-verifier" },
			REVIEW: [{ agent: "reviewer" }, { agent: "reviewer" }],
			CLOSE: { agent: "delegate" },
			RETRO: { agent: "delegate" },
		};
		launches[phase] = [{ agent: "worker" }, { agent: "worker" }];
		const config = JSON.stringify({ defaultProfile: "invalid", profiles: { invalid: launches } });
		await withTemporaryUserExtensionFile("phase-launches.json", config, async () => {
			const harness = createHarness();
			await assert.rejects(
				() => harness.tool("delivery_start", { task: `parallel ${phase} must be rejected` }),
				new RegExp(`${phase}.*parallel|parallel.*${phase}`, "i"),
			);
		});
	}
});

await runTest("legacy non-profile global launch config is rejected", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", JSON.stringify({ VERIFY: { agent: "fresh-verifier", thinking: "extreme" } }), async () => {
		const harness = createHarness();
		await assert.rejects(() => harness.tool("delivery_start", { task: "invalid launch config smoke" }), /must use profile-aware shape/);
	});
});

await runTest("profile launch config missing a phase is rejected", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", JSON.stringify({
		defaultProfile: "broken",
		profiles: {
			broken: {
				IMPLEMENT: { agent: "worker" },
			},
		},
	}), async () => {
		const harness = createHarness();
		await assert.rejects(() => harness.tool("delivery_start", { task: "missing phase smoke" }), /missing required phase: VERIFY/);
	});
});

await runTest("artifact root can be configured from project .pi config", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-cwd-"));
	const configuredRoot = path.join(cwd, "custom-artifacts");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "delivery-state-machine.json"), JSON.stringify({ artifactRoot: "custom-artifacts" }), "utf8");

	try {
		const harness = createHarness({ cwd });
		const result = await harness.tool("delivery_start", { task: "custom artifact root smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		const project = result.details.state.project;
		assert.ok(project.projectId);
		assert.equal(path.relative(configuredRoot, artifactDir).startsWith(path.join("projects", project.projectId, "runs")), true);
		assert.equal(fs.existsSync(artifactDir), true);
		assert.equal(fs.existsSync(path.join(configuredRoot, "projects", project.projectId, "project.json")), true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("trusted project config resolves from git root when cwd is a subdirectory", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-trusted-root-"));
	const cwd = path.join(root, "packages", "app");
	const configuredRoot = path.join(root, "trusted-artifacts");
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "delivery-state-machine.json"), JSON.stringify({ artifactRoot: "trusted-artifacts", maxRounds: { IMPLEMENT: 4 } }), "utf8");
	try {
		execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
		const harness = createHarness({ cwd, projectTrusted: true });
		const result = await harness.tool("delivery_start", { task: "trusted root config" });
		const realRoot = fs.realpathSync(root);
		assert.equal(result.details.state.gitRoot, realRoot);
		assert.equal(result.details.state.maxPhaseRounds.IMPLEMENT, 4);
		assert.equal(path.relative(path.join(realRoot, "trusted-artifacts"), result.details.state.artifactDir).startsWith("projects"), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("untrusted project config is ignored while global and env configuration remain available", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-untrusted-"));
	const projectRoot = path.join(cwd, "project-artifacts");
	const globalRoot = path.join(cwd, "global-artifacts");
	const envRoot = path.join(cwd, "env-artifacts");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "delivery-state-machine.json"), JSON.stringify({ artifactRoot: projectRoot, maxRounds: { IMPLEMENT: 9 } }), "utf8");
	try {
		await withTemporaryUserExtensionFile("../delivery-state-machine.json", JSON.stringify({ artifactRoot: globalRoot, maxRounds: { IMPLEMENT: 4 } }), async () => {
			let harness = createHarness({ cwd, projectTrusted: false });
			let result = await harness.tool("delivery_start", { task: "untrusted project config" });
			assert.equal(result.details.state.maxPhaseRounds.IMPLEMENT, 4);
			assert.equal(path.relative(globalRoot, result.details.state.artifactDir).startsWith("projects"), true);
			assert.equal(fs.existsSync(projectRoot), false);

			process.env.PI_DELIVERY_ARTIFACT_ROOT = envRoot;
			try {
				harness = createHarness({ cwd, projectTrusted: false });
				result = await harness.tool("delivery_start", { task: "untrusted env override" });
				assert.equal(path.relative(envRoot, result.details.state.artifactDir).startsWith("projects"), true);
			} finally {
				delete process.env.PI_DELIVERY_ARTIFACT_ROOT;
			}
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("project layout uses env artifact root and avoids same-folder-name collisions", async () => {
	const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-artifacts-"));
	const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-parent-a-"));
	const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-parent-b-"));
	const cwdA = path.join(parentA, "app");
	const cwdB = path.join(parentB, "app");
	fs.mkdirSync(cwdA, { recursive: true });
	fs.mkdirSync(cwdB, { recursive: true });
	process.env.PI_DELIVERY_ARTIFACT_ROOT = sharedRoot;
	try {
		const harnessA = createHarness({ cwd: cwdA });
		const resultA = await harnessA.tool("delivery_start", { task: "env root project layout a" });
		const harnessB = createHarness({ cwd: cwdB });
		const resultB = await harnessB.tool("delivery_start", { task: "env root project layout b" });

		const projectA = resultA.details.state.project;
		const projectB = resultB.details.state.project;
		assert.equal(projectA.name, "app");
		assert.equal(projectB.name, "app");
		assert.notEqual(projectA.projectId, projectB.projectId);
		assert.equal(path.relative(sharedRoot, resultA.details.state.artifactDir).startsWith(path.join("projects", projectA.projectId, "runs")), true);
		assert.equal(path.relative(sharedRoot, resultB.details.state.artifactDir).startsWith(path.join("projects", projectB.projectId, "runs")), true);
		assert.equal(fs.existsSync(path.join(sharedRoot, "projects", projectA.projectId, "project.json")), true);
		assert.equal(fs.existsSync(path.join(sharedRoot, "projects", projectB.projectId, "project.json")), true);
	} finally {
		delete process.env.PI_DELIVERY_ARTIFACT_ROOT;
		fs.rmSync(sharedRoot, { recursive: true, force: true });
		fs.rmSync(parentA, { recursive: true, force: true });
		fs.rmSync(parentB, { recursive: true, force: true });
	}
});

await runTest("max rounds can be configured per phase", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-rounds-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "delivery-state-machine.json"), JSON.stringify({ maxRounds: { IMPLEMENT: 2, VERIFY: 1, REVIEW: 4 } }), "utf8");

	try {
		const harness = createHarness({ cwd });
		let result = await harness.tool("delivery_start", { task: "custom phase rounds smoke" });
		assert.equal(result.details.state.maxPhaseRounds.IMPLEMENT, 2);
		assert.equal(result.details.state.maxPhaseRounds.VERIFY, 1);
		assert.equal(result.details.state.maxPhaseRounds.REVIEW, 4);

		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented once" });
		result = await harness.tool("delivery_report", {
			phase: "VERIFY",
			verdict: "FAIL",
			summary: "verification blocked at configured max round",
			recommendedDecision: "repair",
		});
		assert.equal(result.details.state.phase, "WAITING_DECISION");
		assert.equal(result.details.state.pendingIssue.recommendedDecision, "repair");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("explicit repair extends exactly one complete exhausted repair cycle", async () => {
	const harness = createHarness();
	await harness.tool("delivery_start", {
		task: "explicit exhausted repair authorization",
		maxRounds: { IMPLEMENT: 1, VERIFY: 1, REVIEW: 1, CLOSE: 1, RETRO: 1 },
	});
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "first implementation" });
	let result = await harness.tool("delivery_report", {
		phase: "VERIFY",
		verdict: "FAIL",
		summary: "exhausted verification failure",
		recommendedDecision: "repair",
	});
	assert.equal(result.details.state.phase, "WAITING_DECISION");

	result = await harness.tool("delivery_decide", { decision: "repair", rationale: "authorize one complete cycle" });
	assert.equal(result.details.state.phase, "IMPLEMENT");
	assert.deepEqual(result.details.state.maxPhaseRounds, {
		IMPLEMENT: 2,
		VERIFY: 2,
		REVIEW: 2,
		CLOSE: 1,
		RETRO: 1,
	});
	assert.equal(result.details.state.verifyRound, 1, "attempt counters are preserved");
	assert.match(result.details.state.history.at(-1).event, /budget|round.*extension/i);
	assert.match(result.details.state.history.at(-1).summary, /IMPLEMENT.*1.*2.*VERIFY.*1.*2.*REVIEW.*1.*2/i);
});

await runTest("each repeated exhausted repair requires a new explicit authorization", async () => {
	const harness = createHarness();
	await harness.tool("delivery_start", {
		task: "repeated exhausted repair authorization",
		maxRounds: { IMPLEMENT: 1, VERIFY: 1, REVIEW: 1, CLOSE: 1, RETRO: 1 },
	});
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "initial implementation" });
	let result = await harness.tool("delivery_report", {
		phase: "VERIFY",
		verdict: "FAIL",
		summary: "first exhausted failure",
		recommendedDecision: "repair",
	});
	assert.equal(result.details.state.phase, "WAITING_DECISION");
	result = await harness.tool("delivery_decide", { decision: "repair", rationale: "authorize second cycle" });
	assert.deepEqual(result.details.state.maxPhaseRounds, { IMPLEMENT: 2, VERIFY: 2, REVIEW: 2, CLOSE: 1, RETRO: 1 });

	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "first repair" });
	result = await harness.tool("delivery_report", {
		phase: "VERIFY",
		verdict: "FAIL",
		summary: "second exhausted failure",
		recommendedDecision: "repair",
	});
	assert.equal(result.details.state.phase, "WAITING_DECISION", "the prior authorization must not silently authorize another cycle");
	assert.deepEqual(result.details.state.maxPhaseRounds, { IMPLEMENT: 2, VERIFY: 2, REVIEW: 2, CLOSE: 1, RETRO: 1 });

	result = await harness.tool("delivery_decide", { decision: "repair", rationale: "authorize third cycle" });
	assert.equal(result.details.state.phase, "IMPLEMENT");
	assert.deepEqual(result.details.state.maxPhaseRounds, { IMPLEMENT: 3, VERIFY: 3, REVIEW: 2, CLOSE: 1, RETRO: 1 }, "only limits exhausted for the newly authorized complete cycle are extended");
	assert.equal(result.details.state.history.filter((entry: any) => entry.event === "repair_budget_extension").length, 2);
});

await runTest("non-repair decisions never extend exhausted budgets", async () => {
	for (const decision of ["accept_risk", "stop"] as const) {
		const harness = createHarness();
		await harness.tool("delivery_start", {
			task: `${decision} does not extend budgets`,
			maxRounds: { IMPLEMENT: 1, VERIFY: 1, REVIEW: 1, CLOSE: 1, RETRO: 1 },
		});
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		let result = await harness.tool("delivery_report", {
			phase: "VERIFY",
			verdict: "FAIL",
			summary: "exhausted verification",
			recommendedDecision: "repair",
		});
		const beforeLimits = structuredClone(result.details.state.maxPhaseRounds);
		result = await harness.tool("delivery_decide", { decision, rationale: `${decision} selected` });
		assert.deepEqual(result.details.state.maxPhaseRounds, beforeLimits);
		assert.equal(result.details.state.history.some((entry: any) => entry.event === "repair_budget_extension"), false);
	}
});

await runTest("legacy continue and defer inputs retain their compatibility mappings", async () => {
	const continued = createHarness();
	await continued.tool("delivery_start", { task: "legacy continue mapping" });
	await continued.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await continued.tool("delivery_report", { phase: "VERIFY", verdict: "FAIL", summary: "known verification risk" });
	let result = await continued.tool("delivery_decide", { decision: "continue", rationale: "legacy caller accepts risk" });
	assert.equal(result.details.state.phase, "REVIEW");
	assert.deepEqual(result.details.state.acceptedRisks, ["verify: known verification risk"]);

	const deferred = createHarness();
	await deferred.tool("delivery_start", { task: "legacy defer mapping" });
	await deferred.tool("delivery_report", { phase: "IMPLEMENT", verdict: "FAIL", summary: "implementation incomplete" });
	result = await deferred.tool("delivery_decide", { decision: "defer", rationale: "legacy caller stops" });
	assert.equal(result.details.state.phase, "STOPPED");
	assert.equal(result.details.state.active, false);
});

await runTest("verify and review failures with recommendedDecision=repair route back to implement", async () => {
	const harness = createHarness();

	await harness.tool("delivery_start", { task: "repair routing smoke", maxRepairRounds: 3 });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "initial implementation" });
	let result = await harness.tool("delivery_report", {
		phase: "VERIFY",
		verdict: "FAIL",
		summary: "verification blocker within scope",
		recommendedDecision: "repair",
	});

	assert.equal(result.details.state.phase, "IMPLEMENT");
	assert.equal(result.details.state.pendingIssue.source, "verify");
	assert.match(result.details.next.childPrompt, /Pending verify issue/);

	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "fixed verification blocker" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verification passed" });
	const reviewNext = await harness.tool("delivery_next");
	writeReviewArtifact(reviewNext.details.next.parallel[0].artifact, "FAIL", "review blocker within scope");
	writeReviewArtifact(reviewNext.details.next.parallel[1].artifact, "PASS", "second reviewer passed");
	result = await harness.tool("delivery_report", {
		phase: "REVIEW",
		verdict: "FAIL",
		summary: "review blocker within scope",
		recommendedDecision: "repair",
	});

	assert.equal(result.details.state.phase, "IMPLEMENT");
	assert.equal(result.details.state.pendingIssue.source, "review");
	assert.match(result.details.next.childPrompt, /Pending review issue/);
});

await runTest("delivery summary writes full journey with failure and repair", async () => {
	const harness = createHarness();

	let result = await harness.tool("delivery_start", { task: "journey report failure repair smoke", maxRepairRounds: 3 });
	const artifactDir = result.details.state.artifactDir as string;
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "initial implementation complete" });
	await harness.tool("delivery_report", {
		phase: "VERIFY",
		verdict: "FAIL",
		summary: "Missing regression coverage for summary report generation.",
		recommendedDecision: "repair",
	});
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "added regression coverage for summary report generation" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verification passed after repair" });
	const reviewNext = await harness.tool("delivery_next");
	writeReviewArtifact(reviewNext.details.next.parallel[0].artifact, "PASS", "reviewer 1 passed");
	writeReviewArtifact(reviewNext.details.next.parallel[1].artifact, "PASS", "reviewer 2 passed");
	await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "both reviewers passed" });
	await harness.tool("delivery_report", { phase: "CLOSE", verdict: "DONE", summary: "closed locally" });
	result = await harness.tool("delivery_report", { phase: "RETRO", verdict: "DONE", summary: "retro complete" });

	assert.equal(result.details.state.phase, "DONE");
	const reportPath = path.join(artifactDir, "00-delivery-summary.md");
	const jsonPath = path.join(artifactDir, "delivery-report.json");
	assert.equal(fs.existsSync(reportPath), true);
	assert.equal(fs.existsSync(jsonPath), true);
	const report = fs.readFileSync(reportPath, "utf8");
	const structuredReport = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
	assert.match(report, /# Delivery summary/);
	assert.match(report, /VERIFY #1/);
	assert.match(report, /VERIFY #2/);
	assert.match(report, /Missing regression coverage/);
	assert.match(report, /added regression coverage/);
	assert.match(report, /## Failure overview/);
	assert.match(report, /unavailable/);
	assert.equal(structuredReport.schemaVersion, 2);
	assert.equal(structuredReport.source, "delivery-state-machine");
	assert.equal(structuredReport.id, path.basename(artifactDir));
	assert.equal(structuredReport.task, "journey report failure repair smoke");
	assert.equal(structuredReport.phase, "DONE");
	assert.equal(structuredReport.status, "DONE");
	assert.equal(structuredReport.artifactDir, artifactDir);
	assert.equal(structuredReport.summaryMarkdownPath, reportPath);
	assert.equal(structuredReport.project.projectId, result.details.state.project.projectId);
	assert.equal(structuredReport.project.name, result.details.state.project.name);
	assert.equal(structuredReport.launchProfile.selectedProfile, result.details.state.launchProfile.selectedProfile);
	assert.ok(Array.isArray(structuredReport.steps));
	assert.ok(structuredReport.steps.some((step: any) => step.phase === "VERIFY" && step.verdict === "FAIL"));
	assert.ok(Array.isArray(structuredReport.history));
	assert.deepEqual(structuredReport.acceptedRisks, []);
	assert.equal(structuredReport.pendingIssue, null);
	assert.equal(structuredReport.usage.currentSessionTotals, null);
	assert.equal(structuredReport.usage.sinceDeliveryStart, null);
	assert.equal(structuredReport.usage.attribution, "unavailable");
	assert.equal(fs.existsSync(`${jsonPath}.tmp-${process.pid}`), false);
});

function projectHarnessEvidence(outcome: "applied" | "none discovered" | "blocked") {
	return `## Project harness discovery and compliance\n- Discovery scope checked: repository root\n- Entry points discovered: none\n- Mandatory references followed: none\n- Phase-relevant rules applied: none\n- Conflicts, gaps, or unreadable instructions: none\n- Outcome: ${outcome}\n`;
}

function phaseArtifactContents(phase: string, verdict: string, summary: string) {
	const runnablePhase = phase as RunnablePhase;
	const contract = PHASE_CONTRACTS[runnablePhase];
	const firstHeading = contract?.requiredHeadings[0];
	const contents = firstHeading ? { [firstHeading]: summary } : {};
	const supportedVerdict = contract.allowedVerdicts.includes(verdict as Verdict) ? verdict as Verdict : contract.allowedVerdicts[0];
	const artifact = renderPhaseArtifactMarkdown(runnablePhase, supportedVerdict, contents).replace(/^RESULT: .*$/m, `RESULT: ${verdict}`);
	return `${artifact}
${projectHarnessEvidence("none discovered")}
`;
}

function writeReviewArtifact(filePath: string, verdict: "PASS" | "PASS_WITH_NON_BLOCKING_NOTES" | "FAIL", summary: string) {
	const contents = {
		Summary: summary,
		"Must-fix findings": verdict === "FAIL" ? `- ${summary}` : "none",
		"Non-blocking notes": verdict === "PASS_WITH_NON_BLOCKING_NOTES" ? `- ${summary}` : "none",
		"Evidence reviewed": "- diff",
		"Risk checks": "- checked",
		Recommendation: verdict === "FAIL" ? "repair" : "none",
	};
	fs.writeFileSync(filePath, `${renderPhaseArtifactMarkdown("REVIEW", verdict, contents)}
${projectHarnessEvidence("none discovered")}`, "utf8");
}

function appendAssistantUsage(sessionFile: string, usage: Record<string, unknown>) {
	fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", usage } })}\n`, "utf8");
}

await runTest("explicit subagent usage is preferred and parent overhead is reported", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-explicit-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "explicit child usage smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		appendAssistantUsage(sessionFile, { input: 80, output: 20, totalTokens: 100, cost: { total: 0.01 } });
		result = await harness.tool("delivery_report", {
			phase: "IMPLEMENT",
			verdict: "PASS",
			summary: "implemented with child usage",
			usageDelta: { input: 30, output: 10, totalTokens: 40, cost: 0.004, assistantMessages: 2, sessionFiles: 1 },
			usageAttribution: "subagent-reported",
			usageSource: "subagent",
			subagentRunId: "child-run-1",
			subagentSessionFile: "/tmp/child-run-1.jsonl",
		});
		const step = result.details.state.steps.find((item: any) => item.phase === "IMPLEMENT");
		assert.equal(step.usageAttribution, "subagent-reported");
		assert.equal(step.usageSource, "subagent");
		assert.equal(step.subagentRunId, "child-run-1");
		assert.equal(step.usageDelta.totalTokens, 40);

		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.deliveryTotal.totalTokens, 100);
		assert.equal(structuredReport.usage.phaseStepsTotal, null);
		assert.equal(structuredReport.usage.parentOverhead, null);
		const summaryText = fs.readFileSync(path.join(artifactDir, "00-delivery-summary.md"), "utf8");
		assert.match(summaryText, /Phase steps total: unavailable/);
		assert.match(summaryText, /Parent\/orchestrator overhead: unavailable/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("subagent session file can populate single-step usage", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-session-file-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	const childSessionFile = path.join(cwd, "child-session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	fs.writeFileSync(childSessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "session file child usage smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		appendAssistantUsage(sessionFile, { input: 80, output: 20, totalTokens: 100, cost: { total: 0.01 } });
		appendAssistantUsage(childSessionFile, { input: 30, output: 10, totalTokens: 40, cost: { total: 0.004 } });
		result = await harness.tool("delivery_report", {
			phase: "IMPLEMENT",
			verdict: "PASS",
			summary: "implemented with child session usage",
			subagentRunId: "child-run-1",
			subagentSessionFile: childSessionFile,
		});
		const step = result.details.state.steps.find((item: any) => item.phase === "IMPLEMENT");
		assert.equal(step.usageAttribution, "subagent-reported");
		assert.equal(step.usageSource, "subagent");
		assert.equal(step.subagentRunId, "child-run-1");
		assert.equal(step.subagentSessionFile, childSessionFile);
		assert.equal(step.usageDelta.totalTokens, 40);
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.phaseStepsTotal, null);
		assert.equal(structuredReport.usage.parentOverhead, null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("parallel stepUsage can resolve usage from subagent run ids", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-run-id-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	const child1 = path.join(cwd, "session", "review-run-1", "run-0", "session.jsonl");
	const child2 = path.join(cwd, "session", "review-run-2", "run-0", "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	fs.mkdirSync(path.dirname(child1), { recursive: true });
	fs.mkdirSync(path.dirname(child2), { recursive: true });
	fs.writeFileSync(child1, "", "utf8");
	fs.writeFileSync(child2, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "parallel run id usage smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		result = await harness.tool("delivery_next");
		const plannedReviewSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW" && step.status === "planned");
		writeReviewArtifact(plannedReviewSteps[0].artifact, "PASS", "reviewer 1 passed");
		writeReviewArtifact(plannedReviewSteps[1].artifact, "PASS", "reviewer 2 passed");
		appendAssistantUsage(sessionFile, { input: 100, output: 20, totalTokens: 120, cost: { total: 0.012 } });
		appendAssistantUsage(child1, { input: 20, output: 5, totalTokens: 25, cost: { total: 0.0025 } });
		appendAssistantUsage(child2, { input: 30, output: 5, totalTokens: 35, cost: { total: 0.0035 } });
		result = await harness.tool("delivery_report", {
			phase: "REVIEW",
			verdict: "PASS",
			summary: "reviewed",
			stepUsage: [
				{ childIndex: 0, subagentRunId: "review-run-1" },
				{ childIndex: 1, subagentRunId: "review-run-2" },
			],
		});
		const childSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW" && step.childIndex !== undefined);
		assert.deepEqual(childSteps.map((step: any) => step.usageDelta.totalTokens), [25, 35]);
		assert.deepEqual(childSteps.map((step: any) => step.usageSource), ["subagent", "subagent"]);
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.phaseStepsTotal, null);
		assert.equal(structuredReport.usage.parentOverhead, null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

function writePiSubagentMeta(artifactsDir: string, opts: {
	runId: string;
	agent: string;
	model?: string;
	usage: Record<string, unknown>;
	transcriptPath?: string;
	task: string;
	timestamp: number;
}) {
	fs.mkdirSync(artifactsDir, { recursive: true });
	const file = path.join(artifactsDir, `${opts.runId}_${opts.agent}_0_meta.json`);
	fs.writeFileSync(file, JSON.stringify(opts), "utf8");
	return file;
}

await runTest("pi-subagents meta scan attributes single-step usage without delivery_report params", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-meta-single-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "meta scan single step smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		result = await harness.tool("delivery_next");
		const plannedStep = result.details.state.steps.find((s: any) => s.phase === "IMPLEMENT" && s.status === "planned");
		const artifactsDir = path.join(cwd, ".pi-subagents", "artifacts");
		writePiSubagentMeta(artifactsDir, {
			runId: "aabbccdd",
			agent: "worker",
			usage: { input: 30, output: 10, totalTokens: 40, cost: 0.004, turns: 2 },
			transcriptPath: path.join(artifactsDir, "aabbccdd_worker_0_transcript.jsonl"),
			task: `Implement this phase.\n\nSave to ${plannedStep.artifact}. Do not call delivery_report.`,
			timestamp: Date.now() + 1000,
		});
		appendAssistantUsage(sessionFile, { input: 80, output: 20, totalTokens: 100, cost: { total: 0.01 } });
		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		const step = result.details.state.steps.find((s: any) => s.phase === "IMPLEMENT");
		assert.equal(step.usageAttribution, "exact");
		assert.equal(step.usageSource, "subagent");
		assert.equal(step.subagentRunId, "aabbccdd");
		assert.equal(step.usageDelta.totalTokens, 40);
		assert.equal(step.usageDelta.assistantMessages, 2);
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		const implementStep = structuredReport.steps.find((s: any) => s.phase === "IMPLEMENT");
		assert.equal(implementStep.usageAttribution, "exact");
		assert.equal(implementStep.usageDelta.totalTokens, 40);
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 40);
		assert.equal(structuredReport.usage.parentOverhead.totalTokens, 60);
		assert.equal(structuredReport.usage.attribution, "exact");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("planned unresolved child keeps usage totals and overhead unavailable", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-planned-child-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "planned child usage completeness" });
		result = await harness.tool("delivery_next");
		const implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT" && step.status === "planned");
		const artifactsDir = path.join(cwd, ".pi-subagents", "artifacts");
		writePiSubagentMeta(artifactsDir, {
			runId: "implemented-child",
			agent: "worker",
			usage: { input: 30, output: 10, totalTokens: 40, cost: 0.004, turns: 2 },
			transcriptPath: path.join(artifactsDir, "implemented-child_worker_0_transcript.jsonl"),
			task: `Implement this phase.\n\nSave to ${implementStep.artifact}. Do not call delivery_report.`,
			timestamp: Date.now() + 1000,
		});
		appendAssistantUsage(sessionFile, { input: 80, output: 20, totalTokens: 100, cost: { total: 0.01 } });
		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		result = await harness.tool("delivery_next");
		assert.ok(result.details.state.steps.some((step: any) => step.phase === "VERIFY" && step.status === "planned"));
		appendAssistantUsage(sessionFile, { input: 20, output: 5, totalTokens: 25, cost: { total: 0.0025 } });

		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(result.details.state.artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.phaseStepsTotal, null);
		assert.equal(structuredReport.usage.parentOverhead, null);
		assert.equal(structuredReport.usage.attribution, "unavailable");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("pi-subagents meta scan discovers metadata in git worktrees", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-meta-worktree-root-"));
	const worktree = `${root}-child-worktree`;
	const sessionFile = path.join(root, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
		fs.writeFileSync(path.join(root, "README.md"), "root\n", "utf8");
		execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["worktree", "add", "-b", "child", worktree], { cwd: root, stdio: "ignore" });
		const harness = createHarness({ cwd: root, sessionFile });
		let result = await harness.tool("delivery_start", { task: "meta scan worktree smoke" });
		result = await harness.tool("delivery_next");
		const plannedStep = result.details.state.steps.find((s: any) => s.phase === "IMPLEMENT" && s.status === "planned");
		const artifactsDir = path.join(worktree, ".pi-subagents", "artifacts");
		writePiSubagentMeta(artifactsDir, {
			runId: "worktree1",
			agent: "worker",
			usage: { input: 25, output: 15, totalTokens: 40, cost: 0.004, turns: 2 },
			transcriptPath: path.join(artifactsDir, "worktree1_worker_0_transcript.jsonl"),
			task: `Implement in sibling worktree.\n\nSave to ${plannedStep.artifact}. Do not call delivery_report.`,
			timestamp: Date.now() + 1000,
		});
		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		const step = result.details.state.steps.find((s: any) => s.phase === "IMPLEMENT");
		assert.equal(step.usageAttribution, "exact");
		assert.equal(step.subagentRunId, "worktree1");
		assert.equal(step.usageDelta.totalTokens, 40);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(worktree, { recursive: true, force: true });
	}
});

await runTest("pi-subagents meta scan attributes parallel child usage and skips aggregate", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-meta-parallel-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "meta scan parallel review smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		result = await harness.tool("delivery_next");
		const plannedReviewSteps = result.details.state.steps.filter((s: any) => s.phase === "REVIEW" && s.status === "planned");
		writeReviewArtifact(plannedReviewSteps[0].artifact, "PASS", "reviewer 1 passed");
		writeReviewArtifact(plannedReviewSteps[1].artifact, "PASS", "reviewer 2 passed");
		const artifactsDir = path.join(cwd, ".pi-subagents", "artifacts");
		const now = Date.now();
		appendAssistantUsage(sessionFile, { input: 100, output: 20, totalTokens: 120, cost: { total: 0.012 } });
		writePiSubagentMeta(artifactsDir, {
			runId: "review11",
			agent: "reviewer",
			usage: { input: 20, output: 5, totalTokens: 25, cost: 0.0025, turns: 1 },
			transcriptPath: path.join(artifactsDir, "review11_reviewer_0_transcript.jsonl"),
			task: `Review diff.\n\nSave to ${plannedReviewSteps[0].artifact}. Do not call delivery_report.`,
			timestamp: now + 1000,
		});
		// second reviewer has different runId but also reviewer agent
		const meta2file = path.join(artifactsDir, `review22_reviewer_1_meta.json`);
		fs.writeFileSync(meta2file, JSON.stringify({
			runId: "review22",
			agent: "reviewer",
			usage: { input: 30, output: 5, totalTokens: 35, cost: 0.0035, turns: 1 },
			transcriptPath: path.join(artifactsDir, "review22_reviewer_1_transcript.jsonl"),
			task: `Review diff.\n\nSave to ${plannedReviewSteps[1].artifact}. Do not call delivery_report.`,
			timestamp: now + 2000,
		}), "utf8");
		result = await harness.tool("delivery_report", {
			phase: "REVIEW",
			verdict: "PASS",
			summary: "both passed",
		});
		const childSteps = result.details.state.steps.filter((s: any) => s.phase === "REVIEW" && s.childIndex !== undefined);
		assert.equal(childSteps[0].usageAttribution, "exact");
		assert.equal(childSteps[0].usageDelta.totalTokens, 25);
		assert.equal(childSteps[0].subagentRunId, "review11");
		assert.equal(childSteps[1].usageAttribution, "exact");
		assert.equal(childSteps[1].usageDelta.totalTokens, 35);
		assert.equal(childSteps[1].subagentRunId, "review22");
		// aggregate row must NOT get meta usage
		const aggregate = result.details.state.steps.find((s: any) => s.phase === "REVIEW" && s.agent === "aggregate");
		assert.ok(!aggregate.usageDelta || aggregate.usageAttribution !== "exact", "aggregate should not get meta usage");
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.phaseStepsTotal, null, "earlier unresolved children keep the delivery child total incomplete");
		assert.equal(structuredReport.usage.parentOverhead, null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("exact pi-subagents metadata overrides deprecated caller usage", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-meta-explicit-wins-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "explicit wins over meta scan" });
		result = await harness.tool("delivery_next");
		const plannedStep = result.details.state.steps.find((s: any) => s.phase === "IMPLEMENT" && s.status === "planned");
		const artifactsDir = path.join(cwd, ".pi-subagents", "artifacts");
		writePiSubagentMeta(artifactsDir, {
			runId: "metarunid",
			agent: "worker",
			usage: { input: 50, output: 20, totalTokens: 70, cost: 0.007, turns: 3 },
			transcriptPath: path.join(artifactsDir, "metarunid_worker_0_transcript.jsonl"),
			task: `Implement.\n\nSave to ${plannedStep.artifact}. Do not call delivery_report.`,
			timestamp: Date.now() + 1000,
		});
		// pass explicit usageDelta — should win
		result = await harness.tool("delivery_report", {
			phase: "IMPLEMENT",
			verdict: "PASS",
			summary: "implemented",
			usageDelta: { input: 30, output: 10, totalTokens: 40, cost: 0.004, assistantMessages: 2, sessionFiles: 1 },
			usageAttribution: "subagent-reported",
		});
		const step = result.details.state.steps.find((s: any) => s.phase === "IMPLEMENT");
		assert.equal(step.usageDelta.totalTokens, 70, "exact metadata wins over deprecated caller usage");
		assert.equal(step.usageAttribution, "exact");
		assert.equal(step.subagentRunId, "metarunid");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("parallel stepUsage records child usage without aggregate double counting", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-parallel-explicit-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "parallel explicit usage smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		result = await harness.tool("delivery_next");
		const plannedReviewSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW" && step.status === "planned");
		writeReviewArtifact(plannedReviewSteps[0].artifact, "PASS", "reviewer 1 passed");
		writeReviewArtifact(plannedReviewSteps[1].artifact, "PASS", "reviewer 2 passed");
		appendAssistantUsage(sessionFile, { input: 100, output: 20, totalTokens: 120, cost: { total: 0.012 } });
		result = await harness.tool("delivery_report", {
			phase: "REVIEW",
			verdict: "PASS",
			summary: "reviewed",
			stepUsage: [
				{ childIndex: 0, usageDelta: { input: 20, output: 5, totalTokens: 25, cost: 0.0025, assistantMessages: 1, sessionFiles: 1 }, usageAttribution: "subagent-reported", usageSource: "subagent", subagentRunId: "review-1" },
				{ childIndex: 1, usageDelta: { input: 30, output: 5, totalTokens: 35, cost: 0.0035, assistantMessages: 1, sessionFiles: 1 }, usageAttribution: "subagent-reported", usageSource: "subagent", subagentRunId: "review-2" },
			],
		});
		const childSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW" && step.childIndex !== undefined);
		assert.deepEqual(childSteps.map((step: any) => step.usageDelta.totalTokens), [25, 35]);
		assert.deepEqual(childSteps.map((step: any) => step.subagentRunId), ["review-1", "review-2"]);
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.phaseStepsTotal, null);
		assert.equal(structuredReport.usage.parentOverhead, null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("status and summary do not mutate unresolved usage state", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-immutable-usage-"));
	try {
		const sessionFile = path.join(cwd, "session.jsonl");
		fs.writeFileSync(sessionFile, "", "utf8");
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "immutable usage rendering" });
		result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		const before = JSON.stringify(result.details.state);
		appendAssistantUsage(sessionFile, { input: 30, output: 7, totalTokens: 37, cost: { total: 0.0037 } });
		const status = await harness.tool("delivery_status");
		assert.equal(JSON.stringify(status.details.state), before);
		const summary = await harness.tool("delivery_summary");
		assert.equal(JSON.stringify(summary.details.state), before);
		const step = summary.details.state.steps.find((item: any) => item.phase === "IMPLEMENT");
		assert.equal(step.usageAttribution, "unavailable");
		assert.equal(step.usageDelta, undefined);
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

await runTest("usage adapter sums fallback attempts, supports legacy metadata, and rejects ambiguity", async () => {
	const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
	const fixtureMetadata = readPiSubagentMetadataFiles([fixtureDir]);
	const fixtureCurrent = resolvePiSubagentChildUsage({ artifact: "/tmp/current-child.md", agent: "reviewer" }, fixtureMetadata);
	assert.equal(fixtureCurrent.status, "resolved");
	assert.equal(fixtureCurrent.usage?.totalTokens, 41);
	assert.equal(fixtureCurrent.metadataVersion, "modelAttempts");
	const current = usageFromPiSubagentMetadata({ modelAttempts: [
		{ usage: { input: 10, output: 2, cacheRead: 3, cost: 0.01, turns: 1 } },
		{ usage: { input: 20, output: 4, cacheWrite: 5, cost: 0.02, turns: 2 } },
	] });
	assert.equal(current.version, "modelAttempts");
	assert.equal(current.usage?.totalTokens, 44);
	assert.equal(current.usage?.cost, 0.03);
	assert.equal(current.usage?.assistantMessages, 3);
	assert.equal(usageFromPiSubagentMetadata({ usage: { input: 7, output: 3, cost: 0.1, turns: 2 } }).version, "legacy-usage");
	const artifact = "/tmp/planned.md";
	const ambiguous = resolvePiSubagentChildUsage({ artifact, agent: "reviewer" }, [
		{ runId: "shared", agent: "reviewer", task: artifact, transcriptPath: "/tmp/a.jsonl", usage: { input: 1 } },
		{ runId: "shared", agent: "reviewer", task: artifact, transcriptPath: "/tmp/b.jsonl", usage: { input: 2 } },
	]);
	assert.equal(ambiguous.status, "unavailable");
	assert.match(ambiguous.reason ?? "", /ambiguous/);
	const canonical = resolvePiSubagentChildUsage({ artifact, agent: "reviewer" }, [{
		agent: "reviewer",
		task: `Review the candidate.\n\nSave to ${artifact}. Do not call delivery_report.`,
		transcriptPath: "/tmp/canonical.jsonl",
		usage: { input: 3 },
	}]);
	assert.equal(canonical.status, "resolved");
	for (const nearMatch of [`${artifact}.backup`, `${artifact}-copy`, `/tmp/prefix${artifact}`]) {
		const unmatched = resolvePiSubagentChildUsage({ artifact, agent: "reviewer" }, [{
			agent: "reviewer",
			task: `Save to ${nearMatch}.`,
			transcriptPath: "/tmp/wrong-child.jsonl",
			usage: { input: 10 },
		}]);
		assert.equal(unmatched.status, "unavailable", `must not match near artifact path ${nearMatch}`);
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-usage-mismatch-"));
	try {
		const transcriptPath = path.join(dir, "child.jsonl");
		fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", sourceEventType: "message_end", role: "assistant", stopReason: "stop", usage: { input: 99, output: 1 } })}\n`);
		const mismatch = resolvePiSubagentChildUsage({ artifact }, [{ agent: "reviewer", task: artifact, transcriptPath, modelAttempts: [{ usage: { input: 1, output: 1 } }] }]);
		assert.equal(mismatch.status, "mismatch");
		assert.match(mismatch.reason ?? "", /contradicts/);

		const completeTranscriptPath = path.join(dir, "complete-child.jsonl");
		fs.writeFileSync(completeTranscriptPath, `${JSON.stringify({ recordType: "message", sourceEventType: "message_end", role: "assistant", stopReason: "stop", usage: { input: 8, output: 2 } })}\n`);
		const fallback = resolvePiSubagentChildUsage({ artifact }, [{ agent: "reviewer", task: artifact, transcriptPath: completeTranscriptPath }]);
		assert.equal(fallback.status, "resolved");
		assert.equal(fallback.usage?.totalTokens, 10);
		assert.equal(fallback.metadataVersion, "unknown");

		const incompleteTranscriptPath = path.join(dir, "incomplete-child.jsonl");
		fs.writeFileSync(incompleteTranscriptPath, `${JSON.stringify({ recordType: "message", sourceEventType: "message_end", role: "assistant", stopReason: "toolUse", usage: { input: 8, output: 2 } })}\n`);
		const incomplete = resolvePiSubagentChildUsage({ artifact }, [{ agent: "reviewer", task: artifact, transcriptPath: incompleteTranscriptPath }]);
		assert.equal(incomplete.status, "unavailable");
		assert.match(incomplete.reason ?? "", /incomplete/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await runTest("parallel reviewer aggregate report preserves child verdict artifacts and writes clean aggregate", async () => {
	const harness = createHarness();

	await harness.tool("delivery_start", { task: "parallel review summary smoke" });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	const next = await harness.tool("delivery_next");
	const plannedReviewSteps = next.details.state.steps.filter((step: any) => step.phase === "REVIEW");
	assert.equal(plannedReviewSteps.length, 2);
	writeReviewArtifact(plannedReviewSteps[0].artifact, "FAIL", "Reviewer 1 found a blocker.");
	writeReviewArtifact(plannedReviewSteps[1].artifact, "PASS", "Reviewer 2 found no blockers.");

	const result = await harness.tool("delivery_report", {
		phase: "REVIEW",
		verdict: "FAIL",
		summary: "reviewer 1 FAIL: missing artifact note; reviewer 2 PASS: no blockers",
		recommendedDecision: "repair",
	});
	const summary = await harness.tool("delivery_summary");
	const text = summary.content[0].text as string;
	const reviewSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW");
	const childSteps = reviewSteps.filter((step: any) => step.childIndex !== undefined);
	const aggregateStep = reviewSteps.find((step: any) => step.id === "REVIEW-1-aggregate");

	assert.equal(result.details.state.phase, "IMPLEMENT");
	assert.equal(childSteps.length, 2);
	assert.deepEqual(childSteps.map((step: any) => step.verdict), ["FAIL", "PASS"]);
	assert.equal(aggregateStep?.verdict, "FAIL");
	assert.equal(path.basename(aggregateStep?.artifact), "03-review.md");
	const aggregateText = fs.readFileSync(aggregateStep.artifact, "utf8");
	assert.match(aggregateText, /^RESULT: FAIL/);
	assert.match(aggregateText, /Reviewer 1\/2 .*FAIL.*03-review-1-01-reviewer\.md/);
	assert.match(aggregateText, /Reviewer 2\/2 .*PASS.*03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(text, /03-review-1-01-reviewer\.md/);
	assert.match(text, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(text, /\| 3a \| REVIEW \| reviewer \| default \| FAIL \| unavailable \| \[03-review-1-01-reviewer\.md\]/);
	assert.match(text, /\| 3b \| REVIEW \| reviewer \| openai\/gpt-5\.5 \| PASS \| unavailable \| \[03-review-1-02-reviewer-openai-gpt-5-5\.md\]/);
	assert.match(text, /\| 4 \| REVIEW \| aggregate \| parent \| FAIL \| unavailable \| \[03-review\.md\]/);
});

await runTest("CLOSE repair preserves lineage through nested IMPLEMENT failure and schedules fresh downstream attempts", async () => {
	const harness = createHarness();
	let result = await advanceHarnessToPhase(harness, "CLOSE");
	result = await harness.tool("delivery_report", {
		phase: "CLOSE",
		verdict: "FAIL",
		summary: "close found a code-changing issue",
		recommendedDecision: "repair",
	});
	result = await harness.tool("delivery_decide", { decision: "repair", rationale: "repair close blocker" });
	assert.equal(result.details.state.phase, "IMPLEMENT");
	assert.equal(result.details.state.pendingIssue.source, "close");

	result = await harness.tool("delivery_report", {
		phase: "IMPLEMENT",
		verdict: "FAIL",
		summary: "first close repair attempt failed",
	});
	assert.equal(result.details.state.phase, "WAITING_DECISION");
	assert.equal(result.details.state.pendingIssue.source, "close", "nested failure retains the initiating CLOSE issue");
	assert.equal(result.details.state.pendingIssue.phase, "IMPLEMENT");

	result = await harness.tool("delivery_decide", { decision: "repair", rationale: "retry nested implementation failure" });
	result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "close repair completed" });
	assert.equal(result.details.state.phase, "VERIFY");
	assert.equal(result.details.state.verifyRound, 2);
	assert.equal(result.details.state.reviewRound, 2);
	result = await harness.tool("delivery_next");
	const plannedVerify = result.details.state.steps.find((step: any) => step.phase === "VERIFY" && step.attempt === 2 && step.status === "planned");
	assert.ok(plannedVerify);
	assert.match(plannedVerify.artifact, /02-verification-2/);

	result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "reverified close repair" });
	result = await harness.tool("delivery_next");
	assert.equal(result.details.state.phase, "REVIEW");
	assert.ok(result.details.state.steps.some((step: any) => step.phase === "REVIEW" && step.attempt === 2 && step.status === "planned"));
	for (const launch of result.details.next.parallel) writeReviewArtifact(launch.artifact, "PASS", "close repair reviewed");
	result = await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "close repair reviewed" });
	assert.equal(result.details.state.phase, "CLOSE");
});

await runTest("invalid generated aggregate links reject before replacing the destination", async () => {
	const original = createHarness();
	await advanceHarnessToPhase(original, "REVIEW");
	await original.tool("delivery_next");
	const state = structuredClone((await original.tool("delivery_status")).details.state);
	const reviewSteps = state.steps.filter((step: any) => step.phase === "REVIEW" && step.childIndex !== undefined);
	for (const step of reviewSteps) {
		step.artifact = step.artifact.replace(/\.md$/, `-${step.childIndex}).md`);
		writeReviewArtifact(step.artifact, "PASS", "review passed");
		assert.equal(fs.existsSync(step.artifact), true);
	}
	const aggregate = path.join(state.artifactDir, "03-review.md");
	const sentinel = "existing aggregate must remain intact\n";
	fs.writeFileSync(aggregate, sentinel, "utf8");

	const restored = createHarness({ branchEntries: [{ type: "custom", customType: "delivery-state-machine", data: state }] });
	await restored.emit("session_start");
	const restoredState = (await restored.tool("delivery_status")).details.state;
	for (const step of restoredState.steps.filter((item: any) => item.phase === "REVIEW" && item.childIndex !== undefined)) {
		assert.equal(fs.existsSync(step.artifact), true, `restored child artifact must exist: ${step.artifact}`);
	}
	await assert.rejects(
		() => restored.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "invalid generated links", __omitArtifact: true }),
		/linked local artifact does not exist/i,
	);
	assert.equal(fs.readFileSync(aggregate, "utf8"), sentinel, "aggregate validation failure must not replace the prior destination");
});

await runTest("parallel review report rejects missing child artifacts before recording stale links", async () => {
	const harness = createHarness();

	await harness.tool("delivery_start", { task: "parallel missing child artifact smoke" });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	const next = await harness.tool("delivery_next");
	const plannedReviewSteps = next.details.state.steps.filter((step: any) => step.phase === "REVIEW");

	await assert.rejects(
		() => harness.tool("delivery_report", {
			phase: "REVIEW",
			verdict: "PASS",
			summary: "review passed but child artifacts were not saved",
		}),
		/missing or invalid.*artifact file does not exist/i,
	);

	const status = await harness.tool("delivery_status");
	const reviewSteps = status.details.state.steps.filter((step: any) => step.phase === "REVIEW");
	assert.equal(status.details.state.phase, "REVIEW");
	assert.deepEqual(reviewSteps.map((step: any) => step.status), ["planned", "planned"]);
	assert.deepEqual(reviewSteps.map((step: any) => step.artifact), plannedReviewSteps.map((step: any) => step.artifact));
});

await runTest("parallel review rejects alternate child artifact paths", async () => {
	const harness = createHarness();

	await harness.tool("delivery_start", { task: "parallel actual child artifact path smoke" });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	const next = await harness.tool("delivery_next");
	const artifactDir = next.details.state.artifactDir as string;
	const actualA = path.join(artifactDir, "custom-review-a.md");
	const actualB = path.join(artifactDir, "custom-review-b.md");
	writeReviewArtifact(actualA, "PASS", "Reviewer A passed.");
	writeReviewArtifact(actualB, "PASS", "Reviewer B passed.");

	await assert.rejects(
		() => harness.tool("delivery_report", {
			phase: "REVIEW",
			verdict: "PASS",
			summary: "alternate paths must be rejected",
			artifact: `${actualA}; ${actualB}`,
		}),
		/missing|planned|exact|does not exist/i,
	);
});

await runTest("parallel review repair journey preserves distinct child artifact links per attempt", async () => {
	const harness = createHarness();

	let result = await harness.tool("delivery_start", { task: "parallel review repair summary smoke", maxRepairRounds: 3 });
	const artifactDir = result.details.state.artifactDir as string;
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented initial change" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified initial change" });
	const firstReview = await harness.tool("delivery_next");
	assert.match(firstReview.details.next.parallel[0].childPrompt, /03-review-1-01-reviewer\.md/);
	assert.match(firstReview.details.next.parallel[1].childPrompt, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	writeReviewArtifact(firstReview.details.next.parallel[0].artifact, "FAIL", "repeated review artifacts reused");
	writeReviewArtifact(firstReview.details.next.parallel[1].artifact, "PASS", "reviewer 2 passed");

	result = await harness.tool("delivery_report", {
		phase: "REVIEW",
		verdict: "FAIL",
		summary: "reviewer 1 FAIL: repeated review artifacts reused; reviewer 2 PASS",
		recommendedDecision: "repair",
	});
	assert.equal(result.details.state.phase, "IMPLEMENT");
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "added attempt-specific parallel artifact paths" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified artifact path repair" });
	const secondReview = await harness.tool("delivery_next");
	assert.match(secondReview.details.next.parallel[0].childPrompt, /03-review-2-01-reviewer\.md/);
	assert.match(secondReview.details.next.parallel[1].childPrompt, /03-review-2-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(secondReview.details.next.reportInstruction, /exact planned aggregate path .*03-review-2\.md/);
	assert.doesNotMatch(secondReview.details.next.reportInstruction, /exact planned aggregate path 03-review\.md/);
	writeReviewArtifact(secondReview.details.next.parallel[0].artifact, "PASS", "reviewer 1 passed after repair");
	writeReviewArtifact(secondReview.details.next.parallel[1].artifact, "PASS", "reviewer 2 passed after repair");

	await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "review passed after repair" });
	await harness.tool("delivery_report", { phase: "CLOSE", verdict: "DONE", summary: "closed locally" });
	result = await harness.tool("delivery_report", { phase: "RETRO", verdict: "DONE", summary: "retro complete" });

	assert.equal(result.details.state.phase, "DONE");
	const reviewChildArtifacts = result.details.state.steps
		.filter((step: any) => step.phase === "REVIEW" && step.childIndex !== undefined)
		.map((step: any) => path.relative(artifactDir, step.artifact));
	assert.deepEqual(reviewChildArtifacts, [
		"03-review-1-01-reviewer.md",
		"03-review-1-02-reviewer-openai-gpt-5-5.md",
		"03-review-2-01-reviewer.md",
		"03-review-2-02-reviewer-openai-gpt-5-5.md",
	]);
	assert.equal(new Set(reviewChildArtifacts).size, reviewChildArtifacts.length);

	const report = fs.readFileSync(path.join(artifactDir, "00-delivery-summary.md"), "utf8");
	assert.match(report, /03-review-1-01-reviewer\.md/);
	assert.match(report, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(report, /03-review-2-01-reviewer\.md/);
	assert.match(report, /03-review-2-02-reviewer-openai-gpt-5-5\.md/);
});

await runTest("delivery summary merges legacy history-only reports with newly recorded steps", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-legacy-"));
	const artifactDir = path.join(cwd, "artifacts");
	fs.mkdirSync(artifactDir, { recursive: true });
	artifactDirs.add(artifactDir);
	const oldTimestamp = Date.now() - 10_000;
	const legacyState = {
		active: true,
		task: "legacy history resume smoke",
		phase: "VERIFY",
		verifyRound: 2,
		reviewRound: 1,
		maxRepairRounds: 3,
		maxPhaseRounds: { IMPLEMENT: 3, VERIFY: 3, REVIEW: 3, CLOSE: 3, RETRO: 3 },
		artifactDir,
		cwd,
		readyToClose: false,
		acceptedRisks: [],
		// This simulates state persisted before delivery steps existed.
		history: [
			{ timestamp: oldTimestamp, phase: "IMPLEMENT", event: "start", summary: "legacy start" },
			{ timestamp: oldTimestamp + 1, phase: "IMPLEMENT", event: "report", verdict: "PASS", summary: "legacy initial implementation" },
			{ timestamp: oldTimestamp + 2, phase: "VERIFY", event: "report", verdict: "FAIL", summary: "legacy verification found missing regression" },
			{ timestamp: oldTimestamp + 3, phase: "IMPLEMENT", event: "auto_repair", decision: "repair", summary: "legacy auto repair" },
			{ timestamp: oldTimestamp + 4, phase: "IMPLEMENT", event: "report", verdict: "PASS", summary: "legacy repair implementation" },
		],
		updatedAt: oldTimestamp + 4,
	};

	try {
		const harness = createHarness({ cwd, branchEntries: [{ type: "custom", customType: "delivery-state-machine", data: legacyState }] });
		await harness.emit("session_start");
		await harness.tool("delivery_next");
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "new verification passed after resume" });
		const summary = await harness.tool("delivery_summary");
		const text = summary.content[0].text as string;

		assert.match(text, /IMPLEMENT \| unknown \| default \| PASS \| unavailable \| legacy initial implementation/);
		assert.match(text, /VERIFY \| unknown \| default \| FAIL \| unavailable \| legacy verification found missing regression/);
		assert.match(text, /IMPLEMENT #2 \| unknown \| default \| PASS \| unavailable \| legacy repair implementation/);
		assert.match(text, /VERIFY #2 \| fresh-verifier \| openai\/gpt-5\.5 \| PASS \| unavailable \| \[02-verification-2\.md\]/);
		assert.match(text, /legacy verification found missing regression/);
		assert.match(text, /legacy repair implementation/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("custom-entry state round-trips through session reconstruction", async () => {
	const original = createHarness();
	const started = await original.tool("delivery_start", { task: "custom entry reconstruction" });
	assert.ok(original.appendedEntries.length > 0, "the fake harness records custom entries");

	const restored = createHarness({ branchEntries: original.appendedEntries });
	await restored.emit("session_start");
	const status = await restored.tool("delivery_status");
	assert.equal(status.details.state.task, started.details.state.task);
	assert.equal(status.details.state.phase, started.details.state.phase);
	assert.deepEqual(status.details.state.steps, started.details.state.steps);
	assert.deepEqual(status.details.state.maxPhaseRounds, started.details.state.maxPhaseRounds);
});

await runTest("reconstruction rejects pinned parallel launches for centrally ineligible phases", async () => {
	for (const phase of ["IMPLEMENT", "CLOSE"] as const) {
		const original = createHarness();
		const started = await original.tool("delivery_start", { task: `restore invalid parallel ${phase}` });
		const restoredState = structuredClone(started.details.state);
		restoredState.phase = phase;
		restoredState.phaseLaunches[phase] = [{ agent: "legacy-a" }, { agent: "legacy-b" }];
		const restored = createHarness({ branchEntries: [{ type: "custom", customType: "delivery-state-machine", data: restoredState }] });
		await assert.rejects(
			() => restored.emit("session_start"),
			new RegExp(`${phase}.*cannot use parallel launches`, "i"),
		);
	}
});

await runTest("tool-result and legacy sparse states reconstruct compatibly", async () => {
	const legacyHistory = [{ timestamp: 1, phase: "IMPLEMENT", event: "start", summary: "legacy" }];
	const legacyState = {
		active: true,
		task: "legacy sparse reconstruction",
		phase: "VERIFY",
		verifyRound: 1,
		reviewRound: 1,
		maxRepairRounds: 2,
		readyToClose: false,
		acceptedRisks: [],
		history: legacyHistory,
		updatedAt: 1,
	};
	const branchEntries = [{
		type: "message",
		message: { role: "toolResult", toolName: "delivery_report", details: { state: legacyState } },
	}];
	const restored = createHarness({ branchEntries });
	await restored.emit("session_start");
	const status = await restored.tool("delivery_status");
	assert.equal(status.details.state.task, legacyState.task);
	assert.deepEqual(status.details.state.steps, []);
	assert.deepEqual(status.details.state.maxPhaseRounds, {
		IMPLEMENT: 2,
		VERIFY: 2,
		REVIEW: 2,
		CLOSE: 2,
		RETRO: 2,
	});
	assert.equal(status.details.state.usageAtStart, undefined);
});

await runTest("usage summary marks costs unavailable without usage-bearing session data", async () => {
	const harness = createHarness();

	await harness.tool("delivery_start", { task: "cost unavailable smoke" });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	const summary = await harness.tool("delivery_summary");
	const text = summary.content[0].text as string;

	assert.match(text, /Overall cost: unavailable/);
	assert.match(text, /unavailable means no session usage file\/baseline or no usage-bearing assistant messages/i);
});

await runTest("usage summary does not show exact zero cost for session files with no usage-bearing messages", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-empty-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		await harness.tool("delivery_start", { task: "empty usage file smoke" });
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		const summary = await harness.tool("delivery_summary");
		const text = summary.content[0].text as string;

		assert.match(text, /Overall cost: unavailable/);
		assert.doesNotMatch(text, /Overall cost: \$0\.0000/);
		assert.match(text, /Total: unavailable \(current session has no usage-bearing assistant messages\)/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("usage summary reports total cost and phase token usage since delivery_start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		await harness.tool("delivery_start", { task: "usage baseline smoke" });
		fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 25, cacheRead: 15, cacheWrite: 5, totalTokens: 145, cost: { total: 0.0123 } } } })}\n`, "utf8");
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented with usage" });
		const summary = await harness.tool("delivery_summary");
		const text = summary.content[0].text as string;

		assert.match(text, /Overall cost: \$0\.0123/);
		assert.match(text, /Overall tokens: 145/);
		assert.match(text, /Overall input tokens: 100/);
		assert.match(text, /Overall output tokens: 25/);
		assert.match(text, /Overall cache read tokens: 15/);
		assert.match(text, /Overall cache write tokens: 5/);
		assert.match(text, /\| # \| Phase \| Agent \| Model \| Verdict \| Token usage \| Detail \|/);
		assert.match(text, /\| PASS \| unavailable \|/);
		assert.doesNotMatch(text, /\$0\.0123 \(best-effort\)/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("CLOSE guard uses canonical phase state and detects wrapped close commands", async () => {
	const harness = createHarness();
	const started = await harness.tool("delivery_start", { task: "close guard wrappers" });
	const dangerous = [
		"git push",
		"git -C /tmp/repo push origin main",
		"env FOO=bar git push",
		"env -u GIT_DIR git push",
		"env -u GIT_DIR /usr/bin/git push",
		"env --unset GIT_DIR /usr/bin/git push",
		"env -S 'git push'",
		"env --split-string='git push'",
		"command git push",
		"/usr/bin/git push",
		"echo ok; git push",
		"echo ok\ngh pr create --fill",
		"glab mr create --fill",
		"bash -c 'git push'",
		"bash -c -- 'git push'",
		"bash --norc -c 'git push'",
		"bash --rcfile /dev/null -lc 'git push'",
		"sh -c \"env git push\"",
		"sh -c -- '/usr/bin/git push'",
	];
	for (const command of dangerous) {
		const blocked = await harness.emit("tool_call", { toolName: "bash", input: { command } });
		assert.equal(blocked?.block, true, `expected close command to be blocked: ${command}`);
	}
	for (const command of ["echo 'git push'", "printf '%s' 'gh pr create'", "git status", "git push-not-a-command", "command -v git push", "command -V git push"]) {
		assert.equal(await harness.emit("tool_call", { toolName: "bash", input: { command } }), undefined, `expected harmless command to pass: ${command}`);
	}
	assert.equal(harness.eventHandlers.has("user_bash"), false, "human user_bash must not be intercepted");

	const stale = structuredClone(started.details.state);
	stale.readyToClose = true;
	stale.phase = "IMPLEMENT";
	const restored = createHarness({ branchEntries: [{ type: "custom", customType: "delivery-state-machine", data: stale }] });
	await restored.emit("session_start", {});
	const restoredStatus = await restored.tool("delivery_status");
	assert.equal(restoredStatus.details.state.readyToClose, false);
	assert.equal((await restored.emit("tool_call", { toolName: "bash", input: { command: "git push" } }))?.block, true);

	const malformed = createHarness({ branchEntries: [{ type: "custom", customType: "delivery-state-machine", data: { ...stale, phase: "BROKEN", readyToClose: true } }] });
	await malformed.emit("session_start", {});
	const malformedStatus = await malformed.tool("delivery_status");
	assert.equal(malformedStatus.details.state.phase, "WAITING_DECISION");
	assert.equal(malformedStatus.details.state.readyToClose, false);
	assert.equal((await malformed.emit("tool_call", { toolName: "bash", input: { command: "git push" } }))?.block, true);

	const closeHarness = createHarness();
	await advanceHarnessToPhase(closeHarness, "CLOSE");
	assert.equal(await closeHarness.emit("tool_call", { toolName: "bash", input: { command: "git push" } }), undefined);
	const retroState = await closeHarness.tool("delivery_report", { phase: "CLOSE", verdict: "DONE", summary: "closed" });
	assert.equal(retroState.details.state.phase, "RETRO");
	assert.equal(retroState.details.state.readyToClose, false);
	assert.equal(await closeHarness.emit("tool_call", { toolName: "bash", input: { command: "git push" } }), undefined);
});

await runTest("summary extraction prefers canonical Critical fixes and retains legacy fallback", async () => {
	const harness = createHarness();
	let result = await advanceHarnessToPhase(harness, "DONE");
	const retro = result.details.state.steps.find((step: any) => step.phase === "RETRO");
	const canonicalRetro = phaseArtifactContents("RETRO", "DONE", "retro").replace(/## Critical fixes\n+none/, "## Critical fixes\n\ncanonical-marker");
	fs.writeFileSync(retro.artifact, canonicalRetro, "utf8");
	let summary = await harness.tool("delivery_summary");
	assert.match(summary.content[0].text, /canonical-marker/);

	const legacyRetro = phaseArtifactContents("RETRO", "DONE", "retro").replace(/## Critical fixes\n+none/, "## Critical fixes for future plans / delivery\n\nlegacy-marker");
	fs.writeFileSync(retro.artifact, legacyRetro, "utf8");
	summary = await harness.tool("delivery_summary");
	assert.match(summary.content[0].text, /legacy-marker/);
});

await runTest("derived summary write failures warn without changing completed workflow state", async () => {
	const harness = createHarness();
	const result = await advanceHarnessToPhase(harness, "DONE");
	const stateBefore = JSON.stringify(result.details.state);
	const artifactDir = result.details.state.artifactDir as string;
	const markdownPath = path.join(artifactDir, "00-delivery-summary.md");
	const jsonPath = path.join(artifactDir, "delivery-report.json");
	const markdownBefore = fs.readFileSync(markdownPath, "utf8");
	const jsonBefore = fs.readFileSync(jsonPath, "utf8");
	fs.chmodSync(artifactDir, 0o500);
	try {
		const summary = await harness.tool("delivery_summary");
		assert.match(summary.content[0].text, /Report write warning:/);
		assert.match(summary.content[0].text, /Structured JSON write warning:/);
		assert.equal(JSON.stringify(summary.details.state), stateBefore);
		assert.equal(fs.readFileSync(markdownPath, "utf8"), markdownBefore);
		assert.equal(fs.readFileSync(jsonPath, "utf8"), jsonBefore);
	} finally {
		fs.chmodSync(artifactDir, 0o700);
	}
	assert.equal(fs.readdirSync(artifactDir).some((name) => name.includes(".tmp-")), false);

	fs.rmSync(artifactDir, { recursive: true, force: true });
	fs.writeFileSync(artifactDir, "artifact-root-blocker", "utf8");
	const preparationFailure = await harness.tool("delivery_summary");
	assert.match(preparationFailure.content[0].text, /Report write warning:/);
	assert.match(preparationFailure.content[0].text, /Structured JSON write warning:/);
	assert.equal(JSON.stringify(preparationFailure.details.state), stateBefore);
	assert.equal(fs.readFileSync(artifactDir, "utf8"), "artifact-root-blocker");
	assert.equal(fs.readdirSync(path.dirname(artifactDir)).some((name) => name.includes(`${path.basename(artifactDir)}.tmp-`)), false);

	fs.rmSync(artifactDir, { force: true });
	fs.mkdirSync(artifactDir, { recursive: true });
	fs.writeFileSync(markdownPath, markdownBefore, "utf8");
	fs.writeFileSync(jsonPath, jsonBefore, "utf8");
	fs.rmSync(jsonPath);
	fs.mkdirSync(jsonPath);
	const jsonFailure = await harness.tool("delivery_summary");
	assert.doesNotMatch(jsonFailure.content[0].text, /Report write warning:/);
	assert.match(jsonFailure.content[0].text, /Structured JSON write warning:/);
	assert.equal(JSON.stringify(jsonFailure.details.state), stateBefore);
	assert.equal(fs.readdirSync(artifactDir).some((name) => name.includes(".tmp-")), false);
});

await runTest("delivery tool content is bounded while full reports and structured details remain complete", async () => {
	const harness = createHarness();
	const result = await advanceHarnessToPhase(harness, "DONE");
	const retro = result.details.state.steps.find((step: any) => step.phase === "RETRO");
	const largeSection = Array.from({ length: 2600 }, (_, index) => `row-${index}-${"x".repeat(40)}`).join("\n");
	const largeRetro = phaseArtifactContents("RETRO", "DONE", "retro").replace(/## Critical fixes\n+none/, `## Critical fixes\n\n${largeSection}`);
	fs.writeFileSync(retro.artifact, largeRetro, "utf8");
	const summary = await harness.tool("delivery_summary");
	const text = summary.content[0].text as string;
	assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024, "tool content must stay within 50KB");
	assert.ok(text.split("\n").length <= 2000, "tool content must stay within 2,000 lines");
	assert.match(text, /Output truncated to 2000 lines or 50(?:\.0)?KB/);
	assert.equal(summary.details.state.steps.length, result.details.state.steps.length, "structured state must remain complete");
	const fullReport = fs.readFileSync(path.join(result.details.state.artifactDir, "00-delivery-summary.md"), "utf8");
	assert.match(fullReport, /row-2599-/);
});

if (testFailures.length > 0) {
	throw new AggregateError(testFailures.map(({ error }) => error), `${testFailures.length} delivery-state-machine test(s) failed`);
}
