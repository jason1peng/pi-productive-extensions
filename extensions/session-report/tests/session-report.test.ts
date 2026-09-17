import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectSessionReport,
	formatSessionReport,
	serializeSessionReport,
	sessionReportInternals,
	writeSessionReportArtifacts,
} from "../../../shared/session-report.ts";
import sessionReportExtension, { sessionReportInternals as extensionInternals } from "../index.ts";

async function runTest(name: string, fn: () => void | Promise<void>) {
	await fn();
	console.log(`PASS ${name}`);
}

function writeJsonl(filePath: string, entries: unknown[]) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function assistantTools(...items: Array<{ id: string; name: string; arguments?: unknown }>) {
	return { type: "message", message: { role: "assistant", content: items.map((item) => ({ type: "toolCall", ...item })) } };
}

function toolResult(toolCallId: string, toolName: string, isError = false) {
	return { type: "message", message: { role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text: "sensitive result body" }] } };
}

await runTest("missing parent is unavailable and does not fabricate activity or usage", () => {
	const report = collectSessionReport(undefined);
	assert.equal(report.schemaVersion, 1);
	assert.equal(report.reportType, "session-report");
	assert.equal(report.status, "unavailable");
	assert.equal(report.usage.status, "unknown");
	assert.equal(report.usage.total, null);
	assert.equal(report.tools, null);
	assert.equal(report.skills, null);
	assert.equal(report.topology.parent.status, "missing");
	assert.equal(report.evidence.gitLabScanned, false);
	assert.equal(report.evidence.mrDataIncluded, false);
});

await runTest("delegation without persisted child evidence is explicitly ephemeral", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-ephemeral-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "delegate-1", name: "subagent", arguments: { agent: "worker", task: "private prompt" } }] } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.topology.ephemeralSessionCount, 1);
		assert.equal(report.topology.missingSessionCount, 0);
		assert.equal(report.usage.subagents, null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("a discovered missing child keeps subagent usage unknown instead of fabricating zeroes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-missing-child-usage-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.01 } } } },
		]);
		fs.mkdirSync(path.join(root, "parent", "run-child", "run-0"), { recursive: true });
		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.topology.children[0]?.status, "missing");
		assert.equal(report.usage.subagents, null);
		assert.deepEqual(report.usage.total, report.usage.parent);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("chain and repeated parallel delegation records preserve expected ephemeral topology", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-chain-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [{
				type: "toolCall",
				id: "delegate-chain",
				name: "subagent",
				arguments: {
					chain: [
						{ agent: "first", task: "one" },
						{ parallel: [{ agent: "second", task: "two", count: 2 }, { agent: "third", task: "three" }] },
					],
				},
			}] } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.topology.ephemeralSessionCount, 4);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("dynamic fanout bounds do not fabricate ephemeral children", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-dynamic-empty-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [{
				type: "toolCall",
				id: "delegate-dynamic",
				name: "subagent",
				arguments: {
					chain: [{ parallel: { agent: "worker", task: "fan out over persisted items" }, expand: { maxItems: 10, onEmpty: "skip" } }],
				},
			}] } },
		]);
		// pi-subagents creates the outer run root before resolving the dynamic
		// source. An onEmpty:'skip' run leaves this directory with no child.
		fs.mkdirSync(path.join(root, "parent", "run-dynamic-empty"), { recursive: true });
		const report = collectSessionReport(parent);
		assert.equal(report.status, "ok");
		assert.equal(report.topology.children.length, 0);
		assert.equal(report.topology.ephemeralSessionCount, 0);
		assert.equal(report.usage.subagents, null);
		assert.equal(report.usage.status, "partial");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("dynamic fanout topology contains only observed persisted children", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-dynamic-observed-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const child = path.join(root, "parent", "run-observed", "run-0", "session.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [{
				type: "toolCall",
				id: "delegate-dynamic",
				name: "subagent",
				arguments: {
					chain: [{ parallel: { agent: "worker", task: "fan out over persisted items" }, expand: { maxItems: 10 } }],
				},
			}] } },
		]);
		writeJsonl(child, [{ type: "session", id: "child" }, { type: "message", message: { role: "assistant", usage: { input: 2, output: 3, totalTokens: 5 } } }]);
		const report = collectSessionReport(parent);
		assert.equal(report.topology.children.length, 1);
		assert.equal(report.topology.ephemeralSessionCount, 0);
		assert.equal(report.usage.subagents?.totalTokens, 5);
		assert.equal(report.usage.status, "complete");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("an observed dynamic child does not satisfy a missing static delegation", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-dynamic-static-missing-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const dynamicChild = path.join(root, "parent", "run-dynamic", "run-0", "session.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [
				{ type: "toolCall", id: "delegate-static", name: "subagent", arguments: { agent: "worker", task: "missing static child" } },
				{ type: "toolCall", id: "delegate-dynamic", name: "subagent", arguments: { chain: [{ parallel: { agent: "worker", task: "dynamic child" }, expand: { maxItems: 10 } }] } },
			] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "delegate-dynamic", toolName: "subagent", isError: false, details: { runId: "run-dynamic" } } },
		]);
		writeJsonl(dynamicChild, [
			{ type: "session", id: "dynamic-child" },
			{ type: "message", message: { role: "assistant", usage: { input: 2, output: 3, totalTokens: 5 } } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.usage.status, "partial");
		assert.equal(report.topology.ephemeralSessionCount, 1);
		assert.equal(report.topology.children.some((child) => child.runId === "unresolved-1" && child.status === "ephemeral"), true);
		assert.equal(report.topology.children.some((child) => child.runId === "run-dynamic" && child.status === "available"), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("an unlinked dynamic child does not satisfy a missing static delegation", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-dynamic-static-unlinked-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const dynamicChild = path.join(root, "parent", "run-dynamic", "run-0", "session.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [
				{ type: "toolCall", id: "delegate-static", name: "subagent", arguments: { agent: "worker", task: "static child" } },
				{ type: "toolCall", id: "delegate-dynamic", name: "subagent", arguments: { chain: [{ parallel: { agent: "worker", task: "dynamic child" }, expand: { maxItems: 2 } }] } },
			] } },
		]);
		// The empty sibling outer root could be the missing static launch; without
		// a persisted dynamic result runId, it must not make the readable child
		// look like the static delegation completed.
		fs.mkdirSync(path.join(root, "parent", "run-static"), { recursive: true });
		// No parent result runId links this persisted child to the dynamic call.
		writeJsonl(dynamicChild, [
			{ type: "session", id: "dynamic-child" },
			{ type: "message", message: { role: "assistant", usage: { input: 4, output: 6, totalTokens: 10 } } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.usage.status, "partial");
		assert.equal(report.usage.subagents?.totalTokens, 10);
		assert.equal(report.usage.total?.totalTokens, 10);
		assert.equal(report.topology.children.length, 2);
		assert.equal(report.topology.ephemeralSessionCount, 1);
		assert.equal(report.topology.children.some((child) => child.runId === "unresolved-1" && child.status === "ephemeral"), true);
		assert.equal(report.topology.children.some((child) => child.runId === "run-dynamic" && child.status === "available"), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("mixed static and unobserved dynamic fanout keeps child usage unknown without a phantom root", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-dynamic-mixed-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const staticChild = path.join(root, "parent", "run-static", "run-0", "session.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [
				{ type: "toolCall", id: "delegate-static", name: "subagent", arguments: { agent: "worker", task: "static child" } },
				{ type: "toolCall", id: "delegate-dynamic", name: "subagent", arguments: { chain: [{ parallel: { agent: "worker", task: "dynamic child" }, expand: { maxItems: 10, onEmpty: "skip" } }] } },
			] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "delegate-dynamic", toolName: "subagent", isError: false, details: { runId: "run-dynamic-empty" } } },
		]);
		writeJsonl(staticChild, [{ type: "session", id: "static-child" }, { type: "message", message: { role: "assistant", usage: { input: 2, output: 3, totalTokens: 5 } } }]);
		// The runtime creates this outer dynamic root before resolving the source;
		// no child session means there is no dynamic child evidence.
		fs.mkdirSync(path.join(root, "parent", "run-dynamic-empty"), { recursive: true });
		const report = collectSessionReport(parent);
		assert.equal(report.status, "ok");
		assert.equal(report.topology.children.length, 1);
		assert.equal(report.topology.children[0]?.runId, "run-static");
		assert.equal(report.topology.ephemeralSessionCount, 0);
		assert.equal(report.usage.subagents, null);
		assert.equal(report.usage.total?.totalTokens, 0);
		assert.equal(report.usage.status, "partial");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("subagent management records do not create phantom delegated children", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-management-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "inspect-1", name: "subagent", arguments: { action: "get", agent: "worker" } }] } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "ok");
		assert.equal(report.topology.children.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("branch summary markers are represented in topology without changing completeness", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-branch-summary-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "branch_summary", id: "branch-1", parentId: null, fromId: "root", summary: "redacted" },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "ok");
		assert.equal(report.topology.branchedSessionCount, 1);
		assert.equal(report.topology.branchPointCount, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("a symlinked child session is unreadable evidence, never followed", () => {
	if (process.platform === "win32") return;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-symlink-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const child = path.join(root, "parent", "run-linked", "run-0", "session.jsonl");
		const target = path.join(root, "outside.jsonl");
		writeJsonl(parent, [{ type: "session", id: "parent" }]);
		writeJsonl(target, [{ type: "session", id: "outside" }]);
		fs.mkdirSync(path.dirname(child), { recursive: true });
		fs.symlinkSync(target, child);
		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.topology.unreadableSessionCount, 1);
		assert.equal(report.topology.children[0]?.status, "unreadable");
		assert.equal(report.topology.children[0]?.sessionId, null);
		assert.equal(report.usage.subagents, null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("parent and child fixtures separate requested/results/failures, skill evidence, and topology gaps", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-fixture-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const successChild = path.join(root, "parent", "run-success", "run-0", "session.jsonl");
		const failedChild = path.join(root, "parent", "run-failed", "run-0", "session.jsonl");
		fs.mkdirSync(path.join(root, "parent", "run-missing", "run-0"), { recursive: true });
		fs.mkdirSync(path.join(root, "parent", "run-ephemeral"), { recursive: true });
		writeJsonl(parent, [
			{ type: "session", id: "parent-id" },
			{ type: "message", message: { role: "assistant", usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } } } },
			assistantTools(
				{ id: "call-a", name: "bash", arguments: { command: "secret command" } },
				{ id: "call-b", name: "bash" },
				{ id: "call-skill", name: "skill", arguments: { name: "release-secret" } },
				{ id: "call-read", name: "read", arguments: { path: "/private/project/SKILL.md" } },
				{ id: "call-repeat-1", name: "echo" },
				{ id: "call-repeat-2", name: "echo" },
			),
			toolResult("call-a", "bash"),
			toolResult("call-skill", "skill", true),
			toolResult("call-read", "read"),
			toolResult("call-a", "bash"),
			toolResult("unknown-result", "curl", true),
			{ type: "compaction", id: "compact-1", parentId: "branch-parent" },
			{ type: "message", id: "branch-a", parentId: "branch-parent", message: { role: "user", content: [] } },
			{ type: "message", id: "branch-b", parentId: "branch-parent", message: { role: "user", content: [] } },
			"{ malformed fixture line",
		]);
		writeJsonl(successChild, [
			{ type: "session", id: "child-success" },
			{ type: "message", message: { role: "assistant", usage: { input: 3, output: 4, total: 7, cost: 0.02 } } },
			assistantTools({ id: "child-call", name: "read", arguments: { path: "/private/other/SKILL.md" } }),
			toolResult("child-call", "read"),
		]);
		writeJsonl(failedChild, [
			{ type: "session", id: "child-failed" },
			{ recordType: "message", sourceEventType: "message_end", role: "assistant", usage: { input: 1, output: 1, cost: 0.03 } },
			assistantTools({ id: "failed-call", name: "bash" }),
			toolResult("failed-call", "bash", true),
		]);

		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial", "malformed/compacted/missing child evidence is partial");
		assert.equal(report.usage.status, "partial");
		assert.deepEqual(report.usage.parent, {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: 0.01,
			assistantMessages: 1,
			sessionFiles: 1,
		});
		assert.equal(report.usage.subagents?.input, 4);
		assert.equal(report.usage.subagents?.totalTokens, 9);
		assert.equal(report.usage.subagents?.sessionFiles, 2);
		assert.equal(report.usage.total?.totalTokens, 21);
		assert.equal(report.tools?.requested, 8);
		assert.equal(report.tools?.persistedResults, 7);
		assert.equal(report.tools?.failedResults, 3);
		assert.equal(report.tools?.missingResults, 3);
		assert.equal(report.tools?.unmatchedResults, 2);
		assert.equal(report.tools?.duplicateResults, 1);
		assert.equal(report.tools?.byTool.bash?.requested, 3);
		assert.equal(report.tools?.byTool.bash?.failedResults, 1);
		assert.equal(report.tools?.byTool.echo?.missingResults, 2);
		assert.equal(report.skills?.explicitInvocations.count, 1);
		assert.deepEqual(report.skills?.explicitInvocations.names, ["redacted"]);
		assert.equal(report.skills?.skillFileReads.count, 2);
		assert.deepEqual(report.skills?.skillFileReads.names, ["other", "project"], "path labels are normalized and never retain paths");
		assert.equal(report.topology.sessionCount, 5);
		assert.equal(report.topology.availableSessionCount, 3);
		assert.equal(report.topology.missingSessionCount, 1);
		assert.equal(report.topology.ephemeralSessionCount, 1);
		assert.equal(report.topology.compactedSessionCount, 1);
		assert.equal(report.topology.branchedSessionCount, 1);
		assert.equal(report.topology.branchPointCount, 1);
		assert.equal(report.evidence.malformedLineCount, 1);
		assert.equal(report.evidence.compactionCount, 1);
		const serialized = JSON.stringify(report);
		assert.doesNotMatch(serialized, /secret command|release-secret|private\/project|sensitive result body/);
		assert.doesNotMatch(serialized, /gitlab|merge.?request|secret command|private\/project|sensitive result body/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("canonical child discovery ignores modern and custom-location-only evidence", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-canonical-only-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		const modernRoot = path.join(root, "subagent-artifacts");
		const customRoot = path.join(root, "custom-child-root");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			assistantTools({ id: "delegate", name: "subagent", arguments: { agent: "worker", task: "delegated task" } }),
			toolResult("delegate", "subagent"),
		]);
		// These files are intentionally outside the exact parent-derived child
		// root (`<parent session without .jsonl>/`). Neither is P1 evidence.
		writeJsonl(path.join(modernRoot, "run-modern_worker_transcript.jsonl"), [
			{ recordType: "message", sourceEventType: "message_end", role: "assistant", usage: { input: 200, output: 100 } },
		]);
		writeJsonl(path.join(customRoot, "run-custom", "run-0", "session.jsonl"), [
			{ type: "session", id: "custom-child" },
			{ type: "message", message: { role: "assistant", usage: { input: 50, output: 50, totalTokens: 100 } } },
		]);

		const report = collectSessionReport(parent);
		assert.equal(report.status, "partial");
		assert.equal(report.topology.children.length, 1);
		assert.equal(report.topology.children[0]?.status, "ephemeral");
		assert.equal(report.topology.children[0]?.runId, "unresolved-1");
		assert.equal(report.usage.subagents, null);
		assert.equal(report.tools?.byTool.read, undefined);
		assert.equal(report.skills?.explicitInvocations.count, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("SKILL.md suffixes are not counted as file reads", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-skill-suffix-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			assistantTools({ id: "suffix", name: "read", arguments: { path: "/private/SKILL.md.bak" } }),
			{ type: "tool_start", toolName: "read", argsPreview: "/private/SKILL.md.bak" },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.skills?.skillFileReads.count, 0);
		assert.deepEqual(report.skills?.skillFileReads.names, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("SKILL.md detection is case-insensitive only for explicit read file/path arguments", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-skill-arguments-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			assistantTools(
				{ id: "mixed-case", name: "read_file", arguments: { filePath: "/private/project/sKiLl.Md" } },
				{ id: "metadata", name: "read", arguments: { path: "/private/notes.txt", metadata: "/private/SKILL.md" } },
				{ id: "command", name: "read", arguments: { command: "cat /private/SKILL.md" } },
				{ id: "nested", name: "read", arguments: { options: { path: "/private/SKILL.md" } } },
			),
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.skills?.skillFileReads.count, 1);
		assert.deepEqual(report.skills?.skillFileReads.names, ["project"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("SKILL.md text in a non-read tool argument is not a file-read event", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-skill-boundary-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			assistantTools({ id: "bash-1", name: "bash", arguments: { command: "cat /private/SKILL.md" } }),
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.skills?.skillFileReads.count, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("a missing parent path remains missing and does not fabricate activity", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-missing-path-"));
	try {
		const report = collectSessionReport(path.join(root, "missing.jsonl"));
		assert.equal(report.status, "unavailable");
		assert.equal(report.topology.parent.status, "missing");
		assert.equal(report.usage.total, null);
		assert.equal(report.tools, null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("only persisted explicit skill markers count as invocation evidence", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-skill-marker-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "<skill name=\"safe-skill\">prompt body is not retained</skill>" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "A discovered skill was not invoked." }] } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.skills?.explicitInvocations.count, 1);
		assert.deepEqual(report.skills?.explicitInvocations.names, ["safe-skill"]);
		assert.doesNotMatch(JSON.stringify(report), /prompt body|discovered skill/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("unsafe persisted labels cannot mutate aggregate report object keys", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-unsafe-label-"));
	try {
		const parent = path.join(root, "parent.jsonl");
		writeJsonl(parent, [
			{ type: "session", id: "parent" },
			assistantTools({ id: "unsafe-tool", name: "__proto__" }, { id: "unsafe-skill", name: "skill", arguments: { name: "constructor" } }),
			{ type: "message", message: { role: "user", content: [{ type: "text", text: '<skill name="__proto__">redacted</skill>' }] } },
		]);
		const report = collectSessionReport(parent);
		assert.equal(report.tools?.byTool["unknown-tool"]?.requested, 1);
		assert.equal(report.skills?.explicitInvocations.byName.proto, 1);
		assert.equal(report.skills?.explicitInvocations.byName.unknown, 1);
		assert.equal(Object.prototype.requested, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("serialization and markdown are byte-stable for the same report", () => {
	const report = collectSessionReport(undefined);
	assert.equal(serializeSessionReport(report), serializeSessionReport(report));
	assert.equal(formatSessionReport(report), formatSessionReport(report));
	assert.match(serializeSessionReport(report), /\n$/);
	assert.match(formatSessionReport(report), /^# Session report\n/);
});

await runTest("artifact writer keeps generated files private and rejects repository paths", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-artifacts-"));
	try {
		const report = collectSessionReport(undefined);
		const artifacts = writeSessionReportArtifacts(report, { directory: root });
		assert.equal(path.basename(artifacts.jsonPath), "session-report.json");
		assert.equal(path.basename(artifacts.markdownPath), "session-report.md");
		assert.equal(JSON.parse(fs.readFileSync(artifacts.jsonPath, "utf8")).schemaVersion, 1);
		assert.equal(fs.statSync(root).mode & 0o777, 0o700);
		assert.equal(fs.statSync(artifacts.jsonPath).mode & 0o777, 0o600);
		assert.equal(fs.statSync(artifacts.markdownPath).mode & 0o777, 0o600);
		const firstJson = fs.readFileSync(artifacts.jsonPath, "utf8");
		const firstMarkdown = fs.readFileSync(artifacts.markdownPath, "utf8");
		writeSessionReportArtifacts(report, { directory: root });
		assert.equal(fs.readFileSync(artifacts.jsonPath, "utf8"), firstJson);
		assert.equal(fs.readFileSync(artifacts.markdownPath, "utf8"), firstMarkdown);
		assert.throws(() => writeSessionReportArtifacts(report, { directory: process.cwd() }), /outside a git repository/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("extension registers separate command/tool and does not require the low-level event contract", () => {
	const lifecycle = new Map<string, (event: unknown, ctx: unknown) => void>();
	let commandName = "";
	let toolName = "";
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => void) { lifecycle.set(event, handler); },
		registerCommand(name: string) { commandName = name; },
		registerTool(tool: { name: string }) { toolName = tool.name; },
	} as never;
	sessionReportExtension(pi);
	assert.equal(commandName, "session-report");
	assert.equal(toolName, "session_report");
	extensionInternals.resetSessionReportState();
	assert.equal(typeof sessionReportInternals.extractToolRequests, "function");
});
