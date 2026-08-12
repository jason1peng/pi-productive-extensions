import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSessionUsageSnapshot,
	collectSessionUsage,
	collectUsageFromJsonlContent,
	emptyUsageTotals,
	subtractUsageTotals,
	usageTotalsFromRawUsage,
} from "../../../shared/session-usage.ts";
import sessionUsageExtension, { sessionUsageInternals, type SessionUsageSnapshot } from "../index.ts";

async function runTest(name: string, fn: () => void | Promise<void>) {
	await fn();
	console.log(`PASS ${name}`);
}

function writeJsonl(filePath: string, entries: unknown[]) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function usageEntry(usage: Record<string, unknown>) {
	return { type: "message", message: { role: "assistant", usage } };
}

await runTest("shared parser totals parent usage and ignores malformed JSONL", () => {
	const totals = collectUsageFromJsonlContent([
		JSON.stringify(usageEntry({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.0123 } })),
		"{not json",
		JSON.stringify({ type: "message", message: { role: "user", usage: { totalTokens: 999 } } }),
		JSON.stringify(usageEntry({ input: 1, output: 2, total: 10, cost: { total: 0.002 } })),
	].join("\n"), { countSessionFile: true });

	assert.deepEqual(totals, {
		input: 11,
		output: 7,
		cacheRead: 3,
		cacheWrite: 2,
		totalTokens: 30,
		cost: 0.0143,
		assistantMessages: 2,
		sessionFiles: 1,
	});
});

await runTest("explicit token fallback policy prefers totalTokens, then total, then component sum", () => {
	assert.equal(usageTotalsFromRawUsage({ input: 10, output: 1, total: 20, totalTokens: 30 }).totalTokens, 30);
	assert.equal(usageTotalsFromRawUsage({ input: 10, output: 1, total: 20 }).totalTokens, 20);
	assert.equal(usageTotalsFromRawUsage({ input: 10, output: 1, cacheRead: 2, cacheWrite: 3 }).totalTokens, 16);
	assert.equal(usageTotalsFromRawUsage({ input: 1, cost: 0.25, turns: 3 }).cost, 0.25);
	assert.equal(usageTotalsFromRawUsage({ input: 1, cost: 0.25, turns: 3 }).assistantMessages, 3);
});

await runTest("async pi-subagents transcript usage is opt-in and normalized", () => {
	const line = JSON.stringify({ recordType: "message", sourceEventType: "message_end", role: "assistant", usage: { input: 4, output: 2, cost: 0.03 } });
	assert.equal(collectUsageFromJsonlContent(line).totalTokens, 0);
	const totals = collectUsageFromJsonlContent(line, { asyncMessages: true, countSessionFile: true });
	assert.equal(totals.totalTokens, 6);
	assert.equal(totals.cost, 0.03);
	assert.equal(totals.sessionFiles, 1);
});

await runTest("collects parent and child subagent session totals", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-shared-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		const child = path.join(dir, "parent", "run-abc", "run-0", "session.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		writeJsonl(child, [usageEntry({ input: 4, output: 5, totalTokens: 9, cost: { total: 0.002 } })]);

		const result = collectSessionUsage(parent, { childFileName: "session.jsonl" });
		assert.equal(result.rows.length, 2);
		assert.equal(result.rows[0].kind, "parent");
		assert.equal(result.rows[1].kind, "subagent");
		assert.equal(result.rows[1].runId, "run-abc");
		assert.equal(result.rows[1].runIndex, "run-0");
		assert.equal(result.parentAvailable, true);
		assert.equal(result.parentTotals.totalTokens, 3);
		assert.equal(result.subagentTotals.totalTokens, 9);
		assert.equal(result.subagentSessions, 1);
		assert.equal(result.total.totalTokens, 12);
		assert.equal(result.total.assistantMessages, 2);
		assert.equal(result.total.sessionFiles, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("missing and no-usage sessions return empty report totals", () => {
	const missing = sessionUsageInternals.collectCurrentSessionUsage(undefined);
	assert.equal(missing.total.totalTokens, 0);
	assert.equal(missing.rows.length, 0);
	assert.match(sessionUsageInternals.formatUsageReport(missing), /No usage-bearing assistant messages found/);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-empty-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [{ type: "message", message: { role: "user", usage: { totalTokens: 99 } } }]);
		const result = sessionUsageInternals.collectCurrentSessionUsage(parent);
		assert.equal(result.total.totalTokens, 0);
		assert.equal(result.rows.length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("usage delta subtraction never goes below zero", () => {
	const delta = subtractUsageTotals(
		{ input: 10, output: 5, cacheRead: 0, cacheWrite: 1, totalTokens: 16, cost: 0.003, assistantMessages: 2, sessionFiles: 1 },
		{ input: 12, output: 1, cacheRead: 0, cacheWrite: 5, totalTokens: 20, cost: 0.001, assistantMessages: 3, sessionFiles: 4 },
	);
	assert.deepEqual(delta, { input: 0, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0.002, assistantMessages: 0, sessionFiles: 0 });
});

// --- PPE-007 event-contract and snapshot tests ---

interface FakeSessionManager { getSessionFile: () => string | undefined; }
interface FakeExtensionContext { sessionManager: FakeSessionManager; ui: { notify: () => void }; }

interface FakePi {
	events: { emit: (channel: string, data: unknown) => void; on: (channel: string, handler: (data: unknown) => void) => () => void };
	on: (event: string, handler: (event: unknown, ctx: FakeExtensionContext) => void) => void;
	registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: FakeExtensionContext) => Promise<{ content: unknown[]; details: unknown }> }) => void;
	registerCommand: (name: string, command: { handler: (args: string, ctx: FakeExtensionContext) => Promise<void> }) => void;
	appendEntry: (customType: string, data: unknown) => void;
	sendUserMessage: (content: string) => void;
	setSessionName: (name: string) => void;
}

interface Harness {
	pi: FakePi; ctx: FakeExtensionContext;
	emitRequest: (requestId: string) => SessionUsageSnapshot | undefined;
	fireShutdown: () => void;
	fireSessionStart: (ctx: FakeExtensionContext) => void;
	responses: SessionUsageSnapshot[];
	appendedEntries: unknown[]; sentMessages: string[]; sessionNames: string[];
	registeredTool: any; registeredCommand: any;
}

function createSessionUsageHarness(options: { sessionFile?: string } = {}): Harness {
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const lifecycleHandlers = new Map<string, (event: unknown, ctx: FakeExtensionContext) => void>();
	const responses: SessionUsageSnapshot[] = [];
	const appendedEntries: unknown[] = [];
	const sentMessages: string[] = [];
	const sessionNames: string[] = [];
	let registeredTool: any;
	let registeredCommand: any;

	const pi: FakePi = {
		events: {
			emit(channel, data) {
				if (channel === sessionUsageInternals.SESSION_USAGE_RESPONSE_EVENT) responses.push(data as SessionUsageSnapshot);
				eventHandlers.get(channel)?.(data);
			},
			on(channel, handler) { eventHandlers.set(channel, handler); return () => { eventHandlers.delete(channel); }; },
		},
		on(event, handler) { lifecycleHandlers.set(event, handler); },
		registerTool(tool) { registeredTool = tool; },
		registerCommand(name, command) { registeredCommand = command; },
		appendEntry(customType, data) { appendedEntries.push({ customType, data }); },
		sendUserMessage(content) { sentMessages.push(content); },
		setSessionName(name) { sessionNames.push(name); },
	};

	const ctx: FakeExtensionContext = {
		sessionManager: { getSessionFile: () => options.sessionFile },
		ui: { notify() {} },
	};

	sessionUsageExtension(pi as never);
	const sessionStartHandler = lifecycleHandlers.get("session_start");
	if (sessionStartHandler) sessionStartHandler({}, ctx);

	function emitRequest(requestId: string): SessionUsageSnapshot | undefined {
		const before = responses.length;
		pi.events.emit(sessionUsageInternals.SESSION_USAGE_REQUEST_EVENT, { requestId });
		return responses[before];
	}

	function fireShutdown(): void {
		const handler = lifecycleHandlers.get("session_shutdown");
		if (handler) handler({}, ctx);
	}

	function fireSessionStart(nextCtx: FakeExtensionContext): void {
		const handler = lifecycleHandlers.get("session_start");
		if (handler) handler({}, nextCtx);
	}

	return { pi, ctx, emitRequest, fireShutdown, fireSessionStart, responses, appendedEntries, sentMessages, sessionNames, registeredTool, registeredCommand };
}

await runTest("snapshot reports unavailable with zero-shaped totals when parent session file is missing", () => {
	const snapshot = buildSessionUsageSnapshot(undefined, { requestId: "r1" });
	assert.equal(snapshot.requestId, "r1");
	assert.equal(snapshot.status, "unavailable");
	assert.deepEqual(snapshot.parent, emptyUsageTotals());
	assert.deepEqual(snapshot.subagents, emptyUsageTotals());
	assert.deepEqual(snapshot.total, emptyUsageTotals());
	assert.equal(snapshot.subagentSessions, 0);
});

await runTest("snapshot reports unavailable when parent file path does not exist or cannot be read", () => {
	const missing = buildSessionUsageSnapshot(path.join(os.tmpdir(), "ppe-007-no-such-file.jsonl"), { requestId: "r2" });
	assert.equal(missing.status, "unavailable");
	assert.equal(missing.total.totalTokens, 0);
	assert.equal(missing.parent.sessionFiles, 0);
	assert.equal(missing.subagentSessions, 0);

	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-unreadable-parent-"));
	try {
		const unreadable = buildSessionUsageSnapshot(directory, { requestId: "r2-directory" });
		assert.equal(unreadable.status, "unavailable");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

await runTest("snapshot reports ok with zero token totals for an existing no-usage parent", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-empty-snap-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [{ type: "message", message: { role: "user", usage: { totalTokens: 99 } } }]);
		const snapshot = buildSessionUsageSnapshot(parent, { requestId: "r3" });
		assert.equal(snapshot.status, "ok");
		assert.equal(snapshot.parent.assistantMessages, 0);
		assert.equal(snapshot.parent.totalTokens, 0);
		assert.equal(snapshot.parent.cost, 0);
		assert.equal(snapshot.parent.sessionFiles, 1);
		assert.equal(snapshot.subagents.assistantMessages, 0);
		assert.equal(snapshot.total.totalTokens, 0);
		assert.equal(snapshot.subagentSessions, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("snapshot aggregates parent and child totals with exact-once counting", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-snap-agg-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		const child = path.join(dir, "parent", "run-abc", "run-0", "session.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		writeJsonl(child, [usageEntry({ input: 4, output: 5, totalTokens: 9, cost: { total: 0.002 } })]);

		const snapshot = buildSessionUsageSnapshot(parent, { requestId: "r4", childFileName: "session.jsonl" });
		assert.equal(snapshot.status, "ok");
		assert.equal(snapshot.parent.totalTokens, 3);
		assert.equal(snapshot.parent.assistantMessages, 1);
		assert.equal(snapshot.parent.sessionFiles, 1);
		assert.equal(snapshot.subagents.totalTokens, 9);
		assert.equal(snapshot.subagents.assistantMessages, 1);
		assert.equal(snapshot.subagents.sessionFiles, 1);
		assert.equal(snapshot.total.totalTokens, 12);
		assert.equal(snapshot.total.assistantMessages, 2);
		assert.equal(snapshot.total.sessionFiles, 2);
		assert.equal(snapshot.total.cost, 0.003);
		assert.equal(snapshot.subagentSessions, 1);

		const collected = collectSessionUsage(parent, { childFileName: "session.jsonl" });
		assert.equal(collected.total.totalTokens, snapshot.total.totalTokens);
		assert.equal(collected.total.cost, snapshot.total.cost);
		assert.equal(collected.total.assistantMessages, snapshot.total.assistantMessages);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("snapshot ignores child sessions without recorded usage", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-snap-nochild-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		const emptyChild = path.join(dir, "parent", "run-empty", "run-0", "session.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } })]);
		writeJsonl(emptyChild, [{ type: "message", message: { role: "user", usage: { totalTokens: 99 } } }]);
		const snapshot = buildSessionUsageSnapshot(parent, { requestId: "r5", childFileName: "session.jsonl" });
		assert.equal(snapshot.status, "ok");
		assert.equal(snapshot.subagentSessions, 0);
		assert.equal(snapshot.subagents.totalTokens, 0);
		assert.equal(snapshot.total.totalTokens, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("snapshot ignores malformed JSONL lines in parent and child", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-snap-malformed-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		const child = path.join(dir, "parent", "run-x", "run-0", "session.jsonl");
		fs.mkdirSync(path.dirname(parent), { recursive: true });
		fs.writeFileSync(parent, [
			JSON.stringify(usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })),
			"{not json",
			"   ",
		].join("\n") + "\n", "utf8");
		fs.mkdirSync(path.dirname(child), { recursive: true });
		fs.writeFileSync(child, [
			JSON.stringify(usageEntry({ input: 4, output: 5, totalTokens: 9, cost: { total: 0.002 } })),
			"garbage{line",
		].join("\n") + "\n", "utf8");

		const snapshot = buildSessionUsageSnapshot(parent, { requestId: "r6", childFileName: "session.jsonl" });
		assert.equal(snapshot.status, "ok");
		assert.equal(snapshot.parent.totalTokens, 3);
		assert.equal(snapshot.subagents.totalTokens, 9);
		assert.equal(snapshot.total.totalTokens, 12);
		assert.equal(snapshot.subagentSessions, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("snapshot fallback precedence prefers totalTokens then total then component sum", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-snap-fallback-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [
			usageEntry({ input: 10, output: 1, total: 20, totalTokens: 30 }),
			usageEntry({ input: 10, output: 1, total: 20 }),
			usageEntry({ input: 10, output: 1, cacheRead: 2, cacheWrite: 3 }),
		]);
		const snapshot = buildSessionUsageSnapshot(parent, { requestId: "r7" });
		assert.equal(snapshot.parent.totalTokens, 30 + 20 + 16);
		assert.equal(snapshot.parent.assistantMessages, 3);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("snapshot default excludes async message_end records (opt-in default)", () => {
	const asyncLine = JSON.stringify({ recordType: "message", sourceEventType: "message_end", role: "assistant", usage: { input: 4, output: 2, cost: 0.03 } });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-snap-async-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(parent, asyncLine + "\n", "utf8");
		const snapshot = buildSessionUsageSnapshot(parent, { requestId: "r8" });
		assert.equal(snapshot.status, "ok");
		assert.equal(snapshot.parent.totalTokens, 0);
		assert.equal(snapshot.parent.cost, 0);
		assert.equal(snapshot.parent.assistantMessages, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("event request produces a correlated response with the same requestId", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-event-corr-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		const response = harness.emitRequest("req-123");
		assert.equal(harness.responses.length, 1);
		assert.equal(response?.requestId, "req-123");
		assert.equal(response?.status, "ok");
		assert.equal(response?.total.totalTokens, 3);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("event request returns unavailable when no session manager context was captured", () => {
	sessionUsageInternals.resetSessionUsageState();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const responses: SessionUsageSnapshot[] = [];
	const pi = {
		events: {
			emit(channel: string, data: unknown) {
				if (channel === sessionUsageInternals.SESSION_USAGE_RESPONSE_EVENT) responses.push(data as SessionUsageSnapshot);
				eventHandlers.get(channel)?.(data);
			},
			on(channel: string, handler: (data: unknown) => void) { eventHandlers.set(channel, handler); return () => {}; },
		},
		on() {}, registerTool() {}, registerCommand() {}, appendEntry() {}, sendUserMessage() {}, setSessionName() {},
	} as unknown as FakePi;
	sessionUsageExtension(pi as never);
	eventHandlers.get(sessionUsageInternals.SESSION_USAGE_REQUEST_EVENT)?.({ requestId: "orphan" });
	assert.equal(responses.length, 1);
	assert.equal(responses[0]!.requestId, "orphan");
	assert.equal(responses[0]!.status, "unavailable");
	assert.equal(responses[0]!.total.totalTokens, 0);
});

await runTest("session_shutdown clears captured session manager so later requests return unavailable", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-shutdown-clear-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		const before = harness.emitRequest("before-shutdown");
		assert.equal(before?.status, "ok");
		assert.equal(before?.total.totalTokens, 3);

		harness.fireShutdown();
		const after = harness.emitRequest("after-shutdown");
		assert.equal(after?.requestId, "after-shutdown");
		assert.equal(after?.status, "unavailable");
		assert.equal(after?.total.totalTokens, 0);
		assert.equal(after?.parent.totalTokens, 0);
		assert.equal(after?.subagentSessions, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("session switch via shutdown then session_start reads the new session, not the previous one", () => {
	const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-switch-a-"));
	const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-switch-b-"));
	try {
		const parentA = path.join(dirA, "parentA.jsonl");
		const parentB = path.join(dirB, "parentB.jsonl");
		writeJsonl(parentA, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		writeJsonl(parentB, [usageEntry({ input: 10, output: 20, totalTokens: 30, cost: { total: 0.01 } })]);

		const harness = createSessionUsageHarness({ sessionFile: parentA });
		const fromA = harness.emitRequest("session-a");
		assert.equal(fromA?.status, "ok");
		assert.equal(fromA?.total.totalTokens, 3);

		harness.fireShutdown();
		const ctxB: FakeExtensionContext = {
			sessionManager: { getSessionFile: () => parentB },
			ui: { notify() {} },
		};
		harness.fireSessionStart(ctxB);

		const fromB = harness.emitRequest("session-b");
		assert.equal(fromB?.status, "ok");
		assert.equal(fromB?.total.totalTokens, 30);
		assert.equal(fromB?.parent.totalTokens, 30);
		assert.equal(fromB?.total.cost, 0.01);
		assert.equal(JSON.stringify(fromB).includes(parentA), false, "response must not leak previous session path");
	} finally {
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	}
});

await runTest("concurrent event requests are isolated and correlated to their own requestId", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-event-concurrent-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		const r1 = harness.emitRequest("concurrent-1");
		const r2 = harness.emitRequest("concurrent-2");
		assert.equal(harness.responses.length, 2);
		assert.equal(r1?.requestId, "concurrent-1");
		assert.equal(r2?.requestId, "concurrent-2");
		assert.notEqual(r1?.requestId, r2?.requestId);
		assert.equal(r1?.status, "ok");
		assert.equal(r2?.status, "ok");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("event response payload contains no paths, transcripts, or raw messages", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-event-privacy-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		const child = path.join(dir, "parent", "run-abc", "run-0", "session.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		writeJsonl(child, [usageEntry({ input: 4, output: 5, totalTokens: 9, cost: { total: 0.002 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		const response = harness.emitRequest("privacy-1");
		assert.ok(response);
		const serialized = JSON.stringify(response);
		assert.equal(serialized.includes(parent), false, "response must not include parent path");
		assert.equal(serialized.includes(child), false, "response must not include child path");
		assert.equal(serialized.includes("run-abc"), false, "response must not include runId");
		assert.equal(serialized.includes("session.jsonl"), false, "response must not include child filename");
		assert.equal(serialized.includes("message"), false, "response must not include raw message field names");
		assert.equal(serialized.includes("transcript"), false, "response must not include transcript references");
		const allowedKeys = new Set(["requestId", "status", "parent", "subagents", "total", "subagentSessions"]);
		for (const key of Object.keys(response!)) assert.ok(allowedKeys.has(key), `unexpected top-level key: ${key}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("event request does not append entries, send messages, set session name, or trigger a model turn", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-event-noside-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		harness.emitRequest("noside-1");
		assert.equal(harness.appendedEntries.length, 0, "handler must not append entries");
		assert.equal(harness.sentMessages.length, 0, "handler must not send user messages");
		assert.equal(harness.sessionNames.length, 0, "handler must not set session name");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("event request with non-string requestId is ignored", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-event-badid-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		harness.pi.events.emit(sessionUsageInternals.SESSION_USAGE_REQUEST_EVENT, { requestId: 123 });
		harness.pi.events.emit(sessionUsageInternals.SESSION_USAGE_REQUEST_EVENT, {});
		harness.pi.events.emit(sessionUsageInternals.SESSION_USAGE_REQUEST_EVENT, "not-object");
		assert.equal(harness.responses.length, 0, "non-string requestId must not produce a response");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await runTest("existing command and tool remain registered and preserve local path details", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-event-compat-"));
	try {
		const parent = path.join(dir, "parent.jsonl");
		writeJsonl(parent, [usageEntry({ input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } })]);
		const harness = createSessionUsageHarness({ sessionFile: parent });
		assert.ok(harness.registeredCommand, "session-usage-all command must be registered");
		assert.ok(harness.registeredTool, "session_usage_all tool must be registered");
		assert.equal(harness.registeredTool.name, "session_usage_all");
		await harness.registeredCommand.handler("", harness.ctx);
		const toolResult = await harness.registeredTool.execute("id", {}, undefined, undefined, harness.ctx);
		const text = (toolResult.content[0] as { text: string }).text;
		assert.match(text, /Session: .*parent\.jsonl/);
		assert.match(text, /Tokens: 3/);
		assert.ok(toolResult.details && typeof toolResult.details === "object");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
