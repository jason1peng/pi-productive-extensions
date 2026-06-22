import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deliveryStateMachine from "../index.ts";

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
	const target = path.join(os.homedir(), ".pi", "agent", "extensions", "delivery-state-machine", relativePath);
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
	assert.match(action.parallel[0].childPrompt, /03-review-1-01-reviewer\.md/);
	assert.equal(action.parallel[1].agent, "reviewer");
	assert.equal(action.parallel[1].model, "openai/gpt-5.5");
	assert.match(action.parallel[1].childPrompt, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(action.reportInstruction, /After all 2 children complete/);
	assert.match(action.reportInstruction, /aggregates their findings/);
});

await runTest("user launch override can force GPT-only models", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", JSON.stringify({
		IMPLEMENT: { agent: "worker", model: "openai/gpt-5.5" },
		VERIFY: { agent: "fresh-verifier", model: "openai/gpt-5.5", thinking: "low", context: "fresh" },
		REVIEW: [
			{ agent: "reviewer", model: "openai/gpt-5.5" },
			{ agent: "reviewer", model: "openai/gpt-5.5" },
		],
		CLOSE: { agent: "delegate", model: "openai/gpt-5.5", thinking: "low" },
		RETRO: { agent: "delegate", model: "openai/gpt-5.5", thinking: "high" },
	}), async () => {
		const harness = createHarness();
		await harness.tool("delivery_start", { task: "gpt-only launch override smoke" });
		let next = await harness.tool("delivery_next");
		assert.equal(next.details.next.model, "openai/gpt-5.5");

		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
		next = await harness.tool("delivery_next");
		assert.deepEqual(next.details.next.parallel.map((launch: any) => launch.model), ["openai/gpt-5.5", "openai/gpt-5.5"]);
	});
});

await runTest("project phase prompt override wins over user prompt and can replace one section", async () => {
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

			assert.match(next.details.next.childPrompt, /PROJECT VERIFY PROMPT prompt override smoke/);
			assert.doesNotMatch(next.details.next.childPrompt, /USER VERIFY PROMPT/);
			assert.match(next.details.next.orchestratorInstruction, /Launch the configured verifier/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

await runTest("project launch override wins over user launch override", async () => {
	await withTemporaryUserExtensionFile("phase-launches.json", JSON.stringify({
		IMPLEMENT: { agent: "worker", model: "user/model" },
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
			assert.equal(result.details.next.model, "project/model");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

await runTest("project prompt and launch overrides are discovered from git root when cwd is a subdirectory", async () => {
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
		assert.equal(result.details.next.model, "repo-root/model");

		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
		result = await harness.tool("delivery_next");
		assert.match(result.details.next.childPrompt, /REPO ROOT VERIFY PROMPT subdirectory override smoke/);
	} finally {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	}
});

await runTest("phase markdown launch fields are rejected", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-invalid-phase-"));
	try {
		const projectPhasesDir = path.join(cwd, ".pi", "delivery-state-machine", "phases");
		fs.mkdirSync(projectPhasesDir, { recursive: true });
		fs.writeFileSync(path.join(projectPhasesDir, "implement.md"), `---\nphase: IMPLEMENT\nmodel: openai/gpt-5.5\n---\n`, "utf8");
		const harness = createHarness({ cwd });
		await assert.rejects(() => harness.tool("delivery_start", { task: "invalid phase frontmatter smoke" }), /must not declare model/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

await runTest("invalid launch config is rejected", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-invalid-launch-"));
	try {
		const projectConfigDir = path.join(cwd, ".pi", "delivery-state-machine");
		fs.mkdirSync(projectConfigDir, { recursive: true });
		fs.writeFileSync(path.join(projectConfigDir, "phase-launches.json"), JSON.stringify({ VERIFY: { agent: "fresh-verifier", thinking: "extreme" } }), "utf8");
		const harness = createHarness({ cwd });
		await assert.rejects(() => harness.tool("delivery_start", { task: "invalid launch config smoke" }), /invalid VERIFY\[0\]\.thinking=extreme/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
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
		assert.equal(path.dirname(artifactDir), configuredRoot);
		assert.equal(fs.existsSync(artifactDir), true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
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
	await harness.tool("delivery_next");
	await harness.tool("delivery_report", { phase: "REVIEW", verdict: "PASS", summary: "both reviewers passed" });
	await harness.tool("delivery_report", { phase: "CLOSE", verdict: "DONE", summary: "closed locally" });
	result = await harness.tool("delivery_report", { phase: "RETRO", verdict: "DONE", summary: "retro complete" });

	assert.equal(result.details.state.phase, "DONE");
	const reportPath = path.join(artifactDir, "00-delivery-summary.md");
	assert.equal(fs.existsSync(reportPath), true);
	const report = fs.readFileSync(reportPath, "utf8");
	assert.match(report, /# Delivery summary/);
	assert.match(report, /VERIFY #1/);
	assert.match(report, /VERIFY #2/);
	assert.match(report, /Missing regression coverage/);
	assert.match(report, /added regression coverage/);
	assert.match(report, /## Failure overview/);
	assert.match(report, /unavailable/);
});

await runTest("parallel reviewer aggregate report does not fabricate per-child verdicts", async () => {
	const harness = createHarness();

	await harness.tool("delivery_start", { task: "parallel review summary smoke" });
	await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented" });
	await harness.tool("delivery_report", { phase: "VERIFY", verdict: "PASS", summary: "verified" });
	const next = await harness.tool("delivery_next");
	assert.equal(next.details.state.steps.filter((step: any) => step.phase === "REVIEW").length, 2);

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
	assert.deepEqual(childSteps.map((step: any) => step.verdict), [undefined, undefined]);
	assert.equal(aggregateStep?.verdict, "FAIL");
	assert.match(text, /03-review-1-01-reviewer\.md/);
	assert.match(text, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(text, /\| 4 \| REVIEW \| aggregate \| parent \| FAIL \| unavailable \| reviewer 1 FAIL/);
	assert.match(text, /openai\/gpt-5\.5/);
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

await runTest("usage summary reports overall cost since delivery_start when session usage exists", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-sm-usage-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf8");
	try {
		const harness = createHarness({ cwd, sessionFile });
		await harness.tool("delivery_start", { task: "usage baseline smoke" });
		fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 25, totalTokens: 125, cost: { total: 0.0123 } } } })}\n`, "utf8");
		await harness.tool("delivery_report", { phase: "IMPLEMENT", verdict: "PASS", summary: "implemented with usage" });
		const summary = await harness.tool("delivery_summary");
		const text = summary.content[0].text as string;

		assert.match(text, /Overall cost: \$0\.0123/);
		assert.match(text, /Overall tokens: 125/);
		assert.match(text, /\$0\.0123 \(best-effort\)/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
