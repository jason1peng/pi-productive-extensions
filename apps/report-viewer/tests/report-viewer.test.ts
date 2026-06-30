import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createImprovement,
	createServer,
	decideImprovement,
	loadConfig,
	loadReport,
	listRuns,
	reconcileStaleRunningRecords,
	renderMarkdownSafe,
	resolveArtifactPath,
	runApprovedImprovement,
	scanReports,
	type ReportViewerConfig,
} from "../src/server.ts";
import { convertLegacyReport } from "../src/convert-report.ts";

async function runTest(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

function writeJsonReport(dir: string, task: string, overrides: Record<string, unknown> = {}) {
	fs.mkdirSync(dir, { recursive: true });
	const report = {
		schemaVersion: 1,
		source: "delivery-state-machine",
		id: path.basename(dir),
		task,
		status: "DONE",
		phase: "DONE",
		artifactDir: dir,
		cwd: dir,
		gitRoot: dir,
		updatedAt: 1234,
		generatedAt: 1235,
		summaryMarkdownPath: path.join(dir, "00-delivery-summary.md"),
		history: [],
		steps: [{ id: "VERIFY-1", phase: "VERIFY", attempt: 1, status: "reported", artifact: "02-verification.md", startedAt: 1 }],
		acceptedRisks: [],
		pendingIssue: null,
		usage: { currentSessionTotals: null, sinceDeliveryStart: null, attribution: "unavailable" },
		...overrides,
	};
	fs.writeFileSync(path.join(dir, "delivery-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	fs.writeFileSync(path.join(dir, "00-delivery-summary.md"), `# Delivery summary\n\nTask: ${task}\nStatus: DONE\n`, "utf8");
	fs.writeFileSync(path.join(dir, "02-verification.md"), "PASS verification evidence\n", "utf8");
}

function writeLegacyReport(dir: string, task: string) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "00-delivery-summary.md"), `# Delivery summary\n\nTask: ${task}\nStatus: DONE\n<script>alert(1)</script>\n`, "utf8");
}

function configFor(roots: string[], overrides: Partial<ReportViewerConfig> = {}): ReportViewerConfig {
	return {
		reportRoots: roots,
		agentCommand: { bin: "pi", args: [] },
		host: "127.0.0.1",
		port: 0,
		csrfToken: "test-token",
		...overrides,
	};
}

async function withServer(config: ReportViewerConfig, fn: (baseUrl: string) => Promise<void>) {
	const server = createServer(config);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.equal(typeof address, "object");
		await fn(`http://127.0.0.1:${address!.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

await runTest("config defaults to the extension delivery artifact root", () => {
	const config = loadConfig({}, path.join(os.tmpdir(), "missing-report-viewer-config.json"));
	assert.deepEqual(config.reportRoots, [path.join(os.homedir(), ".pi", "delivery-run")]);
	assert.equal(config.agentCommand.bin, "pi");
	assert.equal(config.agentCommand.promptMode, undefined);
	assert.equal(config.host, "127.0.0.1");
	assert.ok(config.csrfToken.length > 20);
});

await runTest("scanReports prefers JSON and keeps IDs unique across roots", () => {
	const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-a-"));
	const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-b-"));
	try {
		writeJsonReport(path.join(rootA, "same-name"), "json-backed task");
		writeLegacyReport(path.join(rootB, "same-name"), "legacy task");
		const reports = scanReports(configFor([rootA, rootB]));
		assert.equal(reports.length, 2);
		assert.notEqual(reports[0].viewerReportId, reports[1].viewerReportId);
		assert.equal(reports.find((report) => report.source === "json")?.task, "json-backed task");
		assert.equal(reports.find((report) => report.source === "legacy-markdown")?.task, "legacy task");
	} finally {
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
	}
});

await runTest("loadReport reads structured JSON and renders escaped Markdown", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-load-"));
	try {
		writeLegacyReport(path.join(root, "legacy"), "legacy <unsafe> task");
		const [reportSummary] = scanReports(configFor([root]));
		const report = loadReport(configFor([root]), reportSummary.viewerReportId);
		assert.equal(report.source, "legacy-markdown");
		assert.match(report.summaryHtml ?? "", /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(report.summaryHtml ?? "", /<script>/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("renderMarkdownSafe escapes embedded HTML", () => {
	assert.equal(renderMarkdownSafe("<b>x</b>"), '<pre class="markdown-report">&lt;b&gt;x&lt;/b&gt;</pre>');
});

await runTest("UI routes render report list, report detail, and artifact content", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-ui-"));
	try {
		writeJsonReport(path.join(root, "run"), "ui route task");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const list = await fetch(`${baseUrl}/reports`);
			assert.equal(list.status, 200);
			assert.match(await list.text(), /ui route task/);
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			assert.match(await detail.text(), /Phase timeline/);
			const artifact = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("02-verification.md")}`);
			assert.equal(artifact.status, 200);
			assert.match(await artifact.text(), /PASS verification evidence/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("state-changing API routes require the local CSRF token", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-csrf-"));
	try {
		writeJsonReport(path.join(root, "run"), "csrf task");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const url = `${baseUrl}/api/reports/${encodeURIComponent(summary.viewerReportId)}/improvements`;
			const missingToken = await fetch(url, { method: "POST", body: JSON.stringify({ title: "Improve", description: "Details" }) });
			assert.equal(missingToken.status, 400);
			assert.match(await missingToken.text(), /CSRF token/);
			const withToken = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", "x-report-viewer-token": config.csrfToken },
				body: JSON.stringify({ title: "Improve", description: "Details" }),
			});
			assert.equal(withToken.status, 201);
			assert.equal((await withToken.json()).status, "proposed");
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("resolveArtifactPath allows report artifacts and rejects traversal and symlink escapes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-paths-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-outside-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "path safety task");
		fs.writeFileSync(path.join(outside, "secret.md"), "secret", "utf8");
		fs.symlinkSync(path.join(outside, "secret.md"), path.join(reportDir, "secret-link.md"));
		const [summary] = scanReports(configFor([root]));
		const allowed = resolveArtifactPath(configFor([root]), summary.viewerReportId, "02-verification.md");
		assert.equal(allowed.kind, "local");
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, "../run/02-verification.md"), /traversal/i);
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, "%2e%2e/run/02-verification.md"), /traversal/i);
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, path.join(outside, "secret.md")), /escapes/i);
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, "secret-link.md"), /escapes/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

await runTest("improvement approval metadata is stored separately and unapproved runs are rejected", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-improvements-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "approval task");
		const [summary] = scanReports(configFor([root]));
		const improvement = createImprovement(configFor([root]), summary.viewerReportId, {
			title: "Improve retro checklist",
			description: "Make future retro output easier to scan.",
		});
		assert.equal(improvement.status, "proposed");
		assert.equal(fs.existsSync(path.join(reportDir, ".report-viewer", "improvements.json")), true);
		assert.equal(fs.existsSync(path.join(reportDir, "delivery-report.json")), true);
		assert.throws(() => runApprovedImprovement(configFor([root]), summary.viewerReportId, improvement.id), /Only approved/);
		const approved = decideImprovement(configFor([root]), summary.viewerReportId, improvement.id, "approved", "looks safe");
		assert.equal(approved.status, "approved");
		assert.ok(approved.approvedAt);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("approved run requires explicit confirmation and enabled non-interactive prompt mode", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-run-gates-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "run gate task");
		const enabledConfig = configFor([root], { agentCommand: { bin: "/bin/cat", args: [], promptMode: "stdin" } });
		const [summary] = scanReports(enabledConfig);
		const improvement = createImprovement(enabledConfig, summary.viewerReportId, {
			title: "Improve retro checklist",
			description: "Make future retro output easier to scan.",
		});
		decideImprovement(enabledConfig, summary.viewerReportId, improvement.id, "approved", "looks safe");
		assert.throws(
			() => runApprovedImprovement(enabledConfig, summary.viewerReportId, improvement.id),
			/Explicit execution confirmation/,
		);
		assert.throws(
			() => runApprovedImprovement(configFor([root]), summary.viewerReportId, improvement.id, { confirmExecution: true }),
			/Agent execution is disabled/,
		);
		await withServer(enabledConfig, async (baseUrl) => {
			const missingConfirm = await fetch(`${baseUrl}/api/reports/${encodeURIComponent(summary.viewerReportId)}/improvements/${encodeURIComponent(improvement.id)}/run`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-report-viewer-token": enabledConfig.csrfToken },
				body: JSON.stringify({}),
			});
			assert.equal(missingConfirm.status, 400);
			assert.match(await missingConfirm.text(), /Explicit execution confirmation/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("stale running records are reconciled on startup", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-stale-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "stale run task");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		const improvement = createImprovement(config, summary.viewerReportId, {
			id: "imp_stale",
			title: "Stale running improvement",
			description: "Previously running when the app stopped.",
		});
		decideImprovement(config, summary.viewerReportId, improvement.id, "approved", "looks safe");
		const metadataDir = path.join(reportDir, ".report-viewer");
		const improvementsPath = path.join(metadataDir, "improvements.json");
		const improvements = JSON.parse(fs.readFileSync(improvementsPath, "utf8"));
		improvements[0].status = "running";
		fs.writeFileSync(improvementsPath, `${JSON.stringify(improvements, null, 2)}\n`, "utf8");
		fs.writeFileSync(path.join(metadataDir, "agent-runs.json"), `${JSON.stringify([{
			id: "run_stale",
			improvementId: improvement.id,
			status: "running",
			commandArgv: ["pi"],
			cwd: reportDir,
			startedAt: "2026-06-30T00:00:00.000Z",
			endedAt: null,
			exitCode: null,
			outputLogPath: ".report-viewer/runs/run_stale.log",
			resultSummary: null,
		}], null, 2)}\n`, "utf8");
		assert.equal(reconcileStaleRunningRecords(config), 1);
		const runs = JSON.parse(fs.readFileSync(path.join(metadataDir, "agent-runs.json"), "utf8"));
		assert.equal(runs[0].status, "unknown");
		assert.match(runs[0].resultSummary, /no live child process/);
		const updatedImprovements = JSON.parse(fs.readFileSync(improvementsPath, "utf8"));
		assert.equal(updatedImprovements[0].status, "failed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("malformed JSON falls back to legacy Markdown without breaking report listing", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-corrupt-"));
	try {
		const corruptDir = path.join(root, "corrupt");
		writeLegacyReport(corruptDir, "corrupt but readable task");
		fs.writeFileSync(path.join(corruptDir, "delivery-report.json"), "{not json", "utf8");
		writeJsonReport(path.join(root, "healthy"), "healthy task");
		const reports = scanReports(configFor([root]));
		assert.equal(reports.length, 2);
		assert.equal(reports.find((report) => report.task === "corrupt but readable task")?.source, "legacy-markdown");
		assert.equal(reports.find((report) => report.task === "healthy task")?.source, "json");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("convertLegacyReport writes deterministic best-effort delivery-report JSON", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-convert-"));
	try {
		const reportDir = path.join(root, "legacy-run");
		fs.mkdirSync(reportDir, { recursive: true });
		fs.writeFileSync(path.join(reportDir, "00-delivery-summary.md"), [
			"# Delivery summary",
			"",
			"Task: legacy conversion task",
			"Status: DONE",
			"Artifact directory: " + reportDir,
			"Cwd: " + root,
			"Branch: main",
			"",
			"## Journey",
			"",
			"| # | Phase | Agent | Model | Verdict | Cost | Detail |",
			"|---|---|---|---|---|---:|---|",
			"| 1 | VERIFY #2 | fresh-verifier | default | PASS | $0 | verification passed |",
		].join("\n"), "utf8");
		const { jsonPath, report } = convertLegacyReport(reportDir, { now: 42 });
		assert.equal(jsonPath, path.join(reportDir, "delivery-report.json"));
		assert.equal(report.source, "legacy-markdown-conversion");
		assert.equal(report.task, "legacy conversion task");
		assert.equal(report.status, "DONE");
		assert.equal(report.phase, null);
		assert.equal(report.cwd, root);
		assert.equal(report.gitBranch, "main");
		assert.equal(report.gitRoot, null);
		assert.equal(report.createdAt, null);
		assert.equal(report.generatedAt, 42);
		assert.equal(report.steps.length, 1);
		assert.equal(report.steps[0].phase, "VERIFY");
		assert.equal(report.steps[0].attempt, 2);
		assert.equal(report.steps[0].startedAt, null);
		assert.equal(report.steps[0].endedAt, null);
		assert.equal(JSON.parse(fs.readFileSync(jsonPath, "utf8")).source, "legacy-markdown-conversion");
		assert.throws(() => convertLegacyReport(reportDir), /already exists/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("convertLegacyReport preserves missing legacy fields as null", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-convert-null-"));
	try {
		const reportDir = path.join(root, "legacy-run");
		fs.mkdirSync(reportDir, { recursive: true });
		fs.writeFileSync(path.join(reportDir, "00-delivery-summary.md"), "# Delivery summary\n", "utf8");
		const { report } = convertLegacyReport(reportDir, { now: 42 });
		assert.equal(report.task, null);
		assert.equal(report.status, null);
		assert.equal(report.phase, null);
		assert.equal(report.cwd, null);
		assert.equal(report.gitBranch, null);
		assert.equal(report.gitRoot, null);
		assert.equal(report.createdAt, null);
		assert.deepEqual(report.steps, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function waitForRunStatus(config: ReportViewerConfig, reportId: string, status: string) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const [run] = listRuns(config, reportId);
		if (run?.status === status) return run;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`Timed out waiting for run status ${status}`);
}

await runTest("approved run success path records completed status and log", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-run-success-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "run success task");
		const config = configFor([root], { agentCommand: { bin: "/bin/cat", args: [], promptMode: "stdin" } });
		const [summary] = scanReports(config);
		const improvement = createImprovement(config, summary.viewerReportId, {
			title: "Successful run improvement",
			description: "Echo the generated prompt through cat.",
		});
		decideImprovement(config, summary.viewerReportId, improvement.id, "approved", "looks safe");
		const record = runApprovedImprovement(config, summary.viewerReportId, improvement.id, { confirmExecution: true });
		assert.equal(record.status, "running");
		const completed = await waitForRunStatus(config, summary.viewerReportId, "completed");
		assert.equal(completed.exitCode, 0);
		const logPath = path.join(reportDir, completed.outputLogPath);
		assert.match(fs.readFileSync(logPath, "utf8"), /Implement this approved retro improvement/);
		assert.equal(fs.existsSync(path.join(reportDir, ".report-viewer", "runs", `${completed.id}-prompt.md`)), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("runs API route returns persisted run records", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-runs-api-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "runs api task");
		const config = configFor([root], { agentCommand: { bin: "/bin/cat", args: [], promptMode: "stdin" } });
		const [summary] = scanReports(config);
		const improvement = createImprovement(config, summary.viewerReportId, {
			title: "Runs API improvement",
			description: "Create a persisted run record for route verification.",
		});
		decideImprovement(config, summary.viewerReportId, improvement.id, "approved", "looks safe");
		const record = runApprovedImprovement(config, summary.viewerReportId, improvement.id, { confirmExecution: true });
		const completed = await waitForRunStatus(config, summary.viewerReportId, "completed");
		await withServer(config, async (baseUrl) => {
			const response = await fetch(`${baseUrl}/api/reports/${encodeURIComponent(summary.viewerReportId)}/runs`);
			assert.equal(response.status, 200);
			const runs = await response.json();
			assert.equal(Array.isArray(runs), true);
			assert.equal(runs.length, 1);
			assert.equal(runs[0].id, record.id);
			assert.equal(runs[0].status, "completed");
			assert.equal(runs[0].exitCode, completed.exitCode);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("listing runs preserves a live running process", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-running-list-"));
	try {
		const reportDir = path.join(root, "run");
		writeJsonReport(reportDir, "slow run task");
		const config = configFor([root], { agentCommand: { bin: "/bin/sh", args: ["-c", "sleep 0.5; cat >/dev/null"], promptMode: "stdin" } });
		const [summary] = scanReports(config);
		const improvement = createImprovement(config, summary.viewerReportId, {
			title: "Slow run improvement",
			description: "Keep the process alive long enough to poll run status.",
		});
		decideImprovement(config, summary.viewerReportId, improvement.id, "approved", "looks safe");
		const record = runApprovedImprovement(config, summary.viewerReportId, improvement.id, { confirmExecution: true });
		assert.equal(record.status, "running");
		const [running] = listRuns(config, summary.viewerReportId);
		assert.equal(running.status, "running");
		const completed = await waitForRunStatus(config, summary.viewerReportId, "completed");
		assert.equal(completed.exitCode, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("report detail UI includes improvement controls and disables non-runnable runs", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-ui-controls-"));
	try {
		writeJsonReport(path.join(root, "run"), "ui controls task");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		createImprovement(config, summary.viewerReportId, {
			title: "Proposed UI-visible improvement",
			description: "Make controls visible.",
		});
		const approved = createImprovement(config, summary.viewerReportId, {
			title: "Approved but disabled improvement",
			description: "Show setup guidance when prompt mode is disabled.",
		});
		decideImprovement(config, summary.viewerReportId, approved.id, "approved", "safe");
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, /Retro improvements/);
			assert.match(html, /Preview prompt/);
			assert.match(html, /Agent runs/);
			assert.match(html, /Run is available only after this improvement is approved/);
			assert.match(html, /Agent execution is disabled/);
			assert.match(html, /data-action="run"[^>]*disabled/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("report detail UI enables run only for approved runnable improvements", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-ui-run-enabled-"));
	try {
		writeJsonReport(path.join(root, "run"), "ui run enabled task");
		const config = configFor([root], { agentCommand: { bin: "/bin/cat", args: [], promptMode: "stdin" } });
		const [summary] = scanReports(config);
		const approved = createImprovement(config, summary.viewerReportId, {
			title: "Runnable improvement",
			description: "Run button should be enabled.",
		});
		decideImprovement(config, summary.viewerReportId, approved.id, "approved", "safe");
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, new RegExp(`data-action="run" data-id="${approved.id}">Run`));
			assert.doesNotMatch(html, /Agent execution is disabled/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("report detail UI falls back to usable cwd when gitRoot is unusable", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-ui-cwd-fallback-"));
	try {
		const reportDir = path.join(root, "run");
		const usableCwd = path.join(root, "usable-cwd");
		fs.mkdirSync(usableCwd, { recursive: true });
		writeJsonReport(reportDir, "ui cwd fallback task", {
			gitRoot: path.join(root, "missing-git-root"),
			cwd: usableCwd,
		});
		const config = configFor([root], { agentCommand: { bin: "/bin/cat", args: [], promptMode: "stdin" } });
		const [summary] = scanReports(config);
		const approved = createImprovement(config, summary.viewerReportId, {
			title: "Runnable via cwd improvement",
			description: "Run button should use cwd when gitRoot is missing.",
		});
		decideImprovement(config, summary.viewerReportId, approved.id, "approved", "safe");
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, new RegExp(`data-action="run" data-id="${approved.id}">Run`));
			assert.doesNotMatch(html, /Agent execution needs a usable gitRoot or cwd/);
		});
		const run = runApprovedImprovement(config, summary.viewerReportId, approved.id, { confirmExecution: true });
		assert.equal(run.cwd, usableCwd);
		await waitForRunStatus(config, summary.viewerReportId, "completed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
