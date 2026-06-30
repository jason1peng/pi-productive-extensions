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
	reconcileStaleRunningRecords,
	renderMarkdownSafe,
	resolveArtifactPath,
	runApprovedImprovement,
	scanReports,
	type ReportViewerConfig,
} from "../src/server.ts";

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
