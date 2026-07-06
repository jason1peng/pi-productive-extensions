import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectSessionUsage,
	collectUsageFromJsonlContent,
	subtractUsageTotals,
	usageTotalsFromRawUsage,
} from "../../../shared/session-usage.ts";
import { sessionUsageInternals } from "../index.ts";

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
