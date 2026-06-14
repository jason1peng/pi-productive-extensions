import assert from "node:assert/strict";
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
		getSessionFile: () => undefined;
		getBranch: () => never[];
	};
}

const artifactDirs = new Set<string>();

function createHarness(options: { cwd?: string } = {}) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
	const sentMessages: string[] = [];

	const pi = {
		appendEntry() {},
		on() {},
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
			getSessionFile: () => undefined,
			getBranch: () => [],
		},
	};

	deliveryStateMachine(pi as any);

	async function tool(name: string, params: Record<string, unknown> = {}) {
		const registered = tools.get(name);
		if (!registered) throw new Error(`Tool not registered: ${name}`);
		const result = await registered.execute(`test-${name}`, params, undefined, undefined, ctx);
		const artifactDir = result?.details?.state?.artifactDir;
		if (artifactDir) artifactDirs.add(artifactDir);
		return result;
	}

	return { tools, commands, sentMessages, ctx, tool };
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
	assert.match(action.parallel[0].childPrompt, /03-review-01-reviewer\.md/);
	assert.equal(action.parallel[1].agent, "reviewer");
	assert.equal(action.parallel[1].model, "openai/gpt-5.5");
	assert.match(action.parallel[1].childPrompt, /03-review-02-reviewer-openai-gpt-5-5\.md/);
	assert.match(action.reportInstruction, /After all 2 children complete/);
	assert.match(action.reportInstruction, /aggregates their findings/);
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
