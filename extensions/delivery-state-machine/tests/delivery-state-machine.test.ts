import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSessionUsage, collectUsageFromJsonlContent, subtractUsageTotals } from "../../../shared/session-usage.ts";
import deliveryStateMachine from "../index.ts";

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

interface RegisteredTool {
	execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: FakeContext) => Promise<any>;
}

interface FakeContext {
	cwd: string;
	hasUI: boolean;
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

function createHarness(options: { cwd?: string; sessionFile?: string; branchEntries?: any[] } = {}) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
	const eventHandlers = new Map<string, (event: unknown, ctx: FakeContext) => Promise<void>>();
	const sentMessages: string[] = [];

	const pi = {
		appendEntry() {},
		on(eventName: string, handler: (event: unknown, ctx: FakeContext) => Promise<void>) {
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
		await handler(event, ctx);
	}

	async function tool(name: string, params: Record<string, unknown> = {}) {
		const registered = tools.get(name);
		if (!registered) throw new Error(`Tool not registered: ${name}`);
		const result = await registered.execute(`test-${name}`, params, undefined, undefined, ctx);
		const artifactDir = result?.details?.state?.artifactDir;
		if (artifactDir) artifactDirs.add(artifactDir);
		return result;
	}

	return { tools, commands, sentMessages, ctx, tool, emit };
}

async function runTest(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} finally {
		for (const dir of artifactDirs) fs.rmSync(dir, { recursive: true, force: true });
		artifactDirs.clear();
	}
}

await runTest("phase prompts define stable artifact contracts", async () => {
	const phaseDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "phases");
	const expected: Record<string, string[]> = {
		implement: ["RESULT: PASS|FAIL", "## Summary", "## Required checklist", "## Changed files", "## Tests added or updated", "## Commands run", "## Evidence", "## Residual risks", "## Recommendation"],
		verify: ["RESULT: PASS|FAIL|INCONCLUSIVE", "## Summary", "## Findings", "## Commands run", "## Behavioral evidence", "## Candidate completeness", "## Residual risks", "## Recommendation"],
		review: ["RESULT: PASS|PASS_WITH_NON_BLOCKING_NOTES|FAIL", "## Summary", "## Must-fix findings", "## Non-blocking notes", "## Evidence reviewed", "## Risk checks", "## Recommendation"],
		close: ["RESULT: MR_CREATED|DONE|FAIL", "## Summary", "## Close-readiness checklist", "## Branch / commit / PR", "## Commands run", "## Remote CI", "## Residual risks"],
		retro: ["RESULT: DONE", "## Outcome", "## Improvement candidates", "## Plan-quality lessons", "## Critical fixes", "## Residual risks", "## Recommendations"],
	};
	for (const [phase, fragments] of Object.entries(expected)) {
		const prompt = fs.readFileSync(path.join(phaseDir, `${phase}.md`), "utf8");
		for (const fragment of fragments) assert.match(prompt, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${phase} prompt includes ${fragment}`);
	}
});

await runTest("delivery child prompts include central RESULT artifact guidance", async () => {
	const harness = createHarness();
	const result = await harness.tool("delivery_start", { task: "artifact guidance smoke" });
	assert.equal(result.details.next.acceptance, false);
	assert.match(result.details.next.childPrompt, /Start the artifact with exactly one result line: RESULT:/);
	assert.match(result.details.next.childPrompt, /Use the phase-specific headings/);
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
	assert.match(action.reportInstruction, /set artifact to only the aggregate artifact path/);
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

function writeReviewArtifact(filePath: string, verdict: "PASS" | "PASS_WITH_NON_BLOCKING_NOTES" | "FAIL", summary: string) {
	fs.writeFileSync(filePath, `RESULT: ${verdict}\n\n## Summary\n${summary}\n\n## Must-fix findings\n${verdict === "FAIL" ? `- ${summary}` : "none"}\n\n## Non-blocking notes\n${verdict === "PASS_WITH_NON_BLOCKING_NOTES" ? `- ${summary}` : "none"}\n\n## Evidence reviewed\n- diff\n\n## Risk checks\n- checked\n\n## Recommendation\n${verdict === "FAIL" ? "repair" : "none"}\n`, "utf8");
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
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 40);
		assert.equal(structuredReport.usage.parentOverhead.totalTokens, 60);
		const summaryText = fs.readFileSync(path.join(artifactDir, "00-delivery-summary.md"), "utf8");
		assert.match(summaryText, /Phase steps total: tokens 40/);
		assert.match(summaryText, /Parent\/orchestrator overhead: tokens 60/);
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
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 40);
		assert.equal(structuredReport.usage.parentOverhead.totalTokens, 60);
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
			artifact: `${plannedReviewSteps[0].artifact}; ${plannedReviewSteps[1].artifact}`,
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
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 60);
		assert.equal(structuredReport.usage.parentOverhead.totalTokens, 120);
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
		assert.equal(step.usageAttribution, "subagent-reported");
		assert.equal(step.usageSource, "subagent");
		assert.equal(step.subagentRunId, "aabbccdd");
		assert.equal(step.usageDelta.totalTokens, 40);
		assert.equal(step.usageDelta.assistantMessages, 2);
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		const implementStep = structuredReport.steps.find((s: any) => s.phase === "IMPLEMENT");
		assert.equal(implementStep.usageAttribution, "subagent-reported");
		assert.equal(implementStep.usageDelta.totalTokens, 40);
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
		assert.equal(step.usageAttribution, "subagent-reported");
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
			artifact: `${plannedReviewSteps[0].artifact}; ${plannedReviewSteps[1].artifact}`,
		});
		const childSteps = result.details.state.steps.filter((s: any) => s.phase === "REVIEW" && s.childIndex !== undefined);
		assert.equal(childSteps[0].usageAttribution, "subagent-reported");
		assert.equal(childSteps[0].usageDelta.totalTokens, 25);
		assert.equal(childSteps[0].subagentRunId, "review11");
		assert.equal(childSteps[1].usageAttribution, "subagent-reported");
		assert.equal(childSteps[1].usageDelta.totalTokens, 35);
		assert.equal(childSteps[1].subagentRunId, "review22");
		// aggregate row must NOT get meta usage
		const aggregate = result.details.state.steps.find((s: any) => s.phase === "REVIEW" && s.agent === "aggregate");
		assert.ok(!aggregate.usageDelta || aggregate.usageAttribution !== "subagent-reported", "aggregate should not get meta usage");
		await harness.tool("delivery_summary");
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 60);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("pi-subagents meta scan does not overwrite explicit delivery_report usage", async () => {
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
		assert.equal(step.usageDelta.totalTokens, 40, "explicit wins over meta");
		assert.equal(step.subagentRunId, undefined, "explicit path does not set meta runId");
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
			artifact: `${plannedReviewSteps[0].artifact}; ${plannedReviewSteps[1].artifact}`,
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
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 60);
		assert.equal(structuredReport.usage.parentOverhead.totalTokens, 60);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("delayed close and retro usage is backfilled from later session totals", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-delayed-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		let result = await harness.tool("delivery_start", { task: "delayed close retro usage smoke" });
		const artifactDir = result.details.state.artifactDir as string;
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		const reviewNext = await harness.tool("delivery_next");
		writeReviewArtifact(reviewNext.details.next.parallel[0].artifact, "PASS", "reviewer 1 passed");
		writeReviewArtifact(reviewNext.details.next.parallel[1].artifact, "PASS", "reviewer 2 passed");
		await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "both reviewers passed" });
		await harness.tool("delivery_next");

		result = await harness.tool("delivery_report", { phase: "CLOSE", verdict: "DONE", summary: "closed locally" });
		let closeStep = result.details.state.steps.find((step: any) => step.phase === "CLOSE");
		assert.equal(closeStep.usageAttribution, "unavailable");
		assert.equal(closeStep.usageDelta, undefined);

		appendAssistantUsage(sessionFile, { input: 30, output: 7, totalTokens: 37, cost: { total: 0.0037 } });
		result = await harness.tool("delivery_next");
		closeStep = result.details.state.steps.find((step: any) => step.phase === "CLOSE");
		assert.equal(closeStep.usageAttribution, "best-effort");
		assert.equal(closeStep.usageDelta.totalTokens, 37);

		result = await harness.tool("delivery_report", { phase: "RETRO", verdict: "DONE", summary: "retro complete" });
		let retroStep = result.details.state.steps.find((step: any) => step.phase === "RETRO");
		assert.equal(retroStep.usageAttribution, "unavailable");
		assert.equal(retroStep.usageDelta, undefined);

		appendAssistantUsage(sessionFile, { input: 11, output: 8, totalTokens: 19, cost: { total: 0.0019 } });
		const summary = await harness.tool("delivery_summary");
		const text = summary.content[0].text as string;
		const structuredReport = JSON.parse(fs.readFileSync(path.join(artifactDir, "delivery-report.json"), "utf8"));
		closeStep = structuredReport.steps.find((step: any) => step.phase === "CLOSE");
		retroStep = structuredReport.steps.find((step: any) => step.phase === "RETRO");
		const reviewSteps = structuredReport.steps.filter((step: any) => step.phase === "REVIEW");

		assert.deepEqual(reviewSteps.map((step: any) => step.usageAttribution), ["unavailable", "unavailable", "unavailable"]);
		assert.equal(closeStep.usageAttribution, "best-effort");
		assert.equal(closeStep.usageDelta.totalTokens, 37);
		assert.equal(retroStep.usageAttribution, "best-effort");
		assert.equal(retroStep.usageDelta.totalTokens, 19);
		assert.equal(structuredReport.usage.phaseStepsTotal.totalTokens, 56);
		assert.equal(structuredReport.usage.parentOverhead, null);
		assert.match(text, /37 tokens \(best-effort\)/);
		assert.match(text, /19 tokens \(best-effort\)/);
		assert.match(text, /Phase steps total: tokens 56/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("delayed usage refreshes a stale planned next-phase boundary", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-stale-boundary-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		await harness.tool("delivery_start", { task: "stale boundary delayed usage smoke" });
		let result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented before usage landed" });
		let implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT");
		assert.equal(implementStep.usageAttribution, "unavailable");

		result = await harness.tool("delivery_next");
		let verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(verifyStep.status, "planned");
		assert.equal(verifyStep.usageBefore.totalTokens, 0);

		appendAssistantUsage(sessionFile, { input: 30, output: 7, totalTokens: 37, cost: { total: 0.0037 } });
		result = await harness.tool("delivery_summary");
		implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT");
		verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(implementStep.usageAttribution, "best-effort");
		assert.equal(implementStep.usageDelta.totalTokens, 37);
		assert.equal(verifyStep.usageBefore.totalTokens, 37);

		appendAssistantUsage(sessionFile, { input: 11, output: 8, totalTokens: 19, cost: { total: 0.0019 } });
		result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified after usage boundary refresh" });
		implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT");
		verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(implementStep.usageDelta.totalTokens, 37);
		assert.equal(verifyStep.usageAttribution, "best-effort");
		assert.equal(verifyStep.usageDelta.totalTokens, 19);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("delayed usage avoids misattribution when first observed during next phase report", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-ambiguous-boundary-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		await harness.tool("delivery_start", { task: "ambiguous delayed usage smoke" });
		let result = await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented before usage landed" });
		let implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT");
		assert.equal(implementStep.usageAttribution, "unavailable");

		result = await harness.tool("delivery_next");
		let verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(verifyStep.status, "planned");
		assert.equal(verifyStep.usageBefore.totalTokens, 0);

		appendAssistantUsage(sessionFile, { input: 30, output: 7, totalTokens: 37, cost: { total: 0.0037 } });
		appendAssistantUsage(sessionFile, { input: 11, output: 8, totalTokens: 19, cost: { total: 0.0019 } });
		result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified before a safe boundary was observed" });
		implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT");
		verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(implementStep.usageAttribution, "unavailable");
		assert.equal(implementStep.usageDelta, undefined);
		assert.equal(verifyStep.usageAttribution, "unavailable");
		assert.equal(verifyStep.usageDelta, undefined);
		assert.equal(verifyStep.usageBefore.totalTokens, 56);

		result = await harness.tool("delivery_next");
		implementStep = result.details.state.steps.find((step: any) => step.phase === "IMPLEMENT");
		verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(implementStep.usageAttribution, "unavailable");
		assert.equal(implementStep.usageDelta, undefined);
		assert.equal(implementStep.usageBackfillBlockedAfter.totalTokens, 56);
		assert.equal(verifyStep.usageAttribution, "unavailable");
		assert.equal(verifyStep.usageDelta, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("delayed usage avoids misattribution when first observed during parallel review report", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-ambiguous-parallel-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		await harness.tool("delivery_start", { task: "ambiguous parallel delayed usage smoke" });
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		let result = await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified before usage landed" });
		let verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		assert.equal(verifyStep.usageAttribution, "unavailable");

		result = await harness.tool("delivery_next");
		const plannedReviewSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW" && step.status === "planned");
		assert.equal(plannedReviewSteps.length, 2);
		assert.deepEqual(plannedReviewSteps.map((step: any) => step.usageBefore.totalTokens), [0, 0]);
		writeReviewArtifact(plannedReviewSteps[0].artifact, "PASS", "reviewer 1 passed");
		writeReviewArtifact(plannedReviewSteps[1].artifact, "PASS", "reviewer 2 passed");

		appendAssistantUsage(sessionFile, { input: 30, output: 7, totalTokens: 37, cost: { total: 0.0037 } });
		appendAssistantUsage(sessionFile, { input: 11, output: 8, totalTokens: 19, cost: { total: 0.0019 } });
		result = await harness.tool("delivery_report", {
			phase: "REVIEW",
			verdict: "PASS",
			summary: "reviewed before a safe usage boundary was observed",
			artifact: `${plannedReviewSteps[0].artifact}; ${plannedReviewSteps[1].artifact}`,
		});
		verifyStep = result.details.state.steps.find((step: any) => step.phase === "VERIFY");
		const reviewSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW");
		assert.equal(verifyStep.usageAttribution, "unavailable");
		assert.equal(verifyStep.usageDelta, undefined);
		assert.equal(verifyStep.usageBackfillBlockedAfter.totalTokens, 56);
		assert.deepEqual(reviewSteps.map((step: any) => step.usageAttribution), ["unavailable", "unavailable", "unavailable"]);
		assert.deepEqual(reviewSteps.map((step: any) => step.usageDelta), [undefined, undefined, undefined]);
		assert.deepEqual(reviewSteps.map((step: any) => step.usageBefore.totalTokens), [56, 56, 56]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
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
		artifact: `${plannedReviewSteps[0].artifact}; ${plannedReviewSteps[1].artifact}`,
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

await runTest("parallel review report can record actual existing child artifact paths", async () => {
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

	const result = await harness.tool("delivery_report", {
		phase: "REVIEW",
		verdict: "PASS",
		summary: "both actual child artifacts passed",
		artifact: `${actualA}; ${actualB}`,
	});
	const childSteps = result.details.state.steps.filter((step: any) => step.phase === "REVIEW" && step.childIndex !== undefined);
	assert.deepEqual(childSteps.map((step: any) => step.artifact), [actualA, actualB]);
	assert.deepEqual(childSteps.map((step: any) => step.verdict), ["PASS", "PASS"]);
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
		assert.match(text, /145 tokens \(best-effort\)/);
		assert.doesNotMatch(text, /\$0\.0123 \(best-effort\)/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
