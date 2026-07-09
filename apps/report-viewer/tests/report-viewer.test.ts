import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createImprovement,
	createServer,
	decideImprovement,
	deliveryAgentDir,
	groupReportsByProject,
	loadConfig,
	loadDeliveryProfileState,
	loadReport,
	reconcileStaleRunningRecords,
	renderMarkdownSafe,
	resolveArtifactPath,
	runApprovedImprovement,
	scanReports,
	type ReportViewerConfig,
} from "../src/server.ts";
import { parseArtifactContract } from "../src/artifact-contract.ts";
import { migrateDeliveryReports } from "../scripts/migrate-delivery-reports.ts";

async function runTest(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

function projectRunDir(root: string, projectId = "project-a-12345678", runId = "run"): string {
	const projectDir = path.join(root, "projects", projectId);
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "project.json"), `${JSON.stringify({
		schemaVersion: 1,
		projectId,
		name: projectId.replace(/-[a-f0-9]{8}$/, ""),
		root: path.join(os.tmpdir(), projectId),
		gitRoot: path.join(os.tmpdir(), projectId),
		gitRemote: `git@example.com:${projectId}.git`,
		createdAt: "2026-07-05T12:00:00.000Z",
		lastSeenAt: "2026-07-05T12:00:00.000Z",
	}, null, 2)}\n`, "utf8");
	return path.join(projectDir, "runs", runId);
}

function writeJsonReport(dir: string, task: string, overrides: Record<string, unknown> = {}) {
	fs.mkdirSync(dir, { recursive: true });
	const projectId = dir.split(path.sep).at(-3);
	const report = {
		schemaVersion: 2,
		source: "delivery-state-machine",
		id: path.basename(dir),
		task,
		status: "DONE",
		phase: "DONE",
		artifactDir: dir,
		cwd: dir,
		gitRoot: dir,
		...(projectId ? { project: { schemaVersion: 1, projectId, name: projectId.replace(/-[a-f0-9]{8}$/, ""), root: dir, createdAt: "2026-07-05T12:00:00.000Z", lastSeenAt: "2026-07-05T12:00:00.000Z" } } : {}),
		launchProfile: { selectedProfile: "default", source: "built-in-default-profile", definitionSource: "built-in-phase-launches", envOverride: false },
		updatedAt: 1234,
		generatedAt: 1235,
		summaryMarkdownPath: path.join(dir, "00-delivery-summary.md"),
		history: [],
		steps: [
			{ id: "IMPLEMENT-1", phase: "IMPLEMENT", attempt: 1, agent: "worker", status: "reported", verdict: "PASS", artifact: "01-implementation.md", summary: "implemented structured report UI", startedAt: 1 },
			{ id: "VERIFY-1", phase: "VERIFY", attempt: 1, agent: "fresh-verifier", status: "reported", verdict: "FAIL", artifact: "02-verification.md", summary: "verification found a missing card", startedAt: 2 },
			{ id: "IMPLEMENT-2", phase: "IMPLEMENT", attempt: 2, agent: "worker", status: "reported", verdict: "PASS", artifact: "01-implementation-2.md", summary: "repair added the missing card", startedAt: 3 },
			{ id: "REVIEW-1", phase: "REVIEW", attempt: 1, agent: "reviewer", status: "reported", verdict: "PASS", artifact: "03-review.md", summary: "review passed", startedAt: 4 },
		],
		acceptedRisks: [],
		pendingIssue: null,
		usage: { currentSessionTotals: null, sinceDeliveryStart: null, attribution: "unavailable" },
		...overrides,
	};
	fs.writeFileSync(path.join(dir, "delivery-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	fs.writeFileSync(path.join(dir, "00-delivery-summary.md"), `# Delivery summary\n\nTask: ${task}\nStatus: DONE\n`, "utf8");
	fs.writeFileSync(path.join(dir, "01-implementation.md"), "RESULT: PASS\n\n## Summary\nImplemented structured report UI.\n\n## Required checklist\n- Expected behavior clarified before changing production code: yes\n\n## Changed files\n- apps/report-viewer/src/server.ts\n\n## Tests added or updated\n- apps/report-viewer/tests/report-viewer.test.ts\n\n## Commands run\n- `npm run report-viewer:verify` - passed\n\n## Evidence\n- phase cards render\n\n## Residual risks\nnone\n\n## Recommendation\nnone\n", "utf8");
	fs.writeFileSync(path.join(dir, "02-verification.md"), "RESULT: PASS\n\n## Summary\nPASS verification evidence\n\n## Findings\nnone\n\n## Commands run\n- `curl /reports` - passed\n\n## Behavioral evidence\n- real HTTP route rendered\n\n## Candidate completeness\n- checked\n\n## Residual risks\nnone\n\n## Recommendation\nnone\n", "utf8");
	fs.writeFileSync(path.join(dir, "03-review.md"), "RESULT: PASS\n\n## Summary\nReview passed.\n\n## Must-fix findings\nnone\n\n## Non-blocking notes\nnone\n\n## Evidence reviewed\n- diff and tests\n\n## Risk checks\n- no blockers\n\n## Recommendation\nnone\n", "utf8");
	fs.writeFileSync(path.join(dir, "04-close.md"), "RESULT: DONE\n\n## Summary\nClosed locally.\n\n## Close-readiness checklist\n- local fast verification passed\n\n## Branch / commit / PR\n- branch: local\n- commit: none\n- pr: none\n\n## Commands run\n- `npm run verify` - passed\n\n## Remote CI\nnone\n\n## Residual risks\nnone\n", "utf8");
	fs.writeFileSync(path.join(dir, "05-retro.md"), "RESULT: DONE\n\n## Outcome\nDelivery completed with structured UI.\n\n## Improvement candidates\n| Title | Severity | Source evidence | Suggested action |\n|---|---|---|---|\n| Add parser fixtures | medium | 03-review.md | Keep contract fixtures current |\n\n## Plan-quality lessons\n- Include consumer-path checks.\n\n## Critical fixes\n| Area | Observed issue | Suggested fix | Scope |\n|---|---|---|---|\n| plan | none | none | task |\n\n## Residual risks\nnone\n\n## Recommendations\n- Monitor legacy fallback.\n", "utf8");
	fs.writeFileSync(path.join(dir, "malformed.md"), "# Unrecognized artifact\n\n<script>alert('owned')</script>\n\nFreeform content without the required contract headings.\n", "utf8");
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

async function withProfileEnv<T>(agentDir: string, fn: () => Promise<T> | T): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousProfile = process.env.PI_DELIVERY_PROFILE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_DELIVERY_PROFILE;
	try {
		return await fn();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousProfile === undefined) delete process.env.PI_DELIVERY_PROFILE;
		else process.env.PI_DELIVERY_PROFILE = previousProfile;
	}
}

function writeProfileConfig(agentDir: string) {
	const configDir = path.join(agentDir, "extensions", "delivery-state-machine");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "phase-launches.json"), JSON.stringify({
		defaultProfile: "premium",
		profiles: {
			premium: {
				IMPLEMENT: { agent: "worker", model: "premium-impl" },
				VERIFY: { agent: "fresh-verifier", model: "premium-verify", context: "fresh" },
				REVIEW: { agent: "reviewer", model: "premium-review" },
				CLOSE: { agent: "delegate", model: "premium-close" },
				RETRO: { agent: "delegate", model: "premium-retro" },
			},
			cheap: {
				IMPLEMENT: { agent: "worker", model: "cheap-impl" },
				VERIFY: { agent: "fresh-verifier", model: "cheap-verify", context: "fresh" },
				REVIEW: { agent: "reviewer", model: "cheap-review" },
				CLOSE: { agent: "delegate", model: "cheap-close" },
				RETRO: { agent: "delegate", model: "cheap-retro" },
			},
		},
	}, null, 2), "utf8");
}

await runTest("config defaults to the extension delivery artifact root", () => {
	const config = loadConfig({}, path.join(os.tmpdir(), "missing-report-viewer-config.json"));
	assert.deepEqual(config.reportRoots, [path.join(os.homedir(), ".pi", "delivery-run")]);
	assert.equal(config.agentCommand.bin, "pi");
	assert.equal(config.agentCommand.promptMode, undefined);
	assert.equal(config.host, "127.0.0.1");
	assert.ok(config.csrfToken.length > 20);
});

await runTest("delivery profile state falls back to built-in definitions", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-built-in-"));
	try {
		await withProfileEnv(agentDir, () => {
			const state = loadDeliveryProfileState();
			assert.equal(deliveryAgentDir(), agentDir);
			assert.equal(state.definitionSource, "built-in-phase-launches");
			assert.ok(state.profiles.includes("default"));
			assert.equal(typeof state.profileDefinitions.default.IMPLEMENT, "object");
			assert.equal(state.activeProfile, "default");
			assert.equal(state.activeSource, "built-in-default-profile");
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

await runTest("delivery profile state uses first global profile when no default is configured", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-first-"));
	try {
		writeProfileConfig(agentDir);
		const configPath = path.join(agentDir, "extensions", "delivery-state-machine", "phase-launches.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		delete config.defaultProfile;
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
		await withProfileEnv(agentDir, () => {
			const state = loadDeliveryProfileState();
			assert.equal(state.definitionSource, "global-phase-launches");
			assert.deepEqual(state.profiles, ["premium", "cheap"]);
			assert.equal(state.activeProfile, "premium");
			assert.equal(state.activeSource, "global-first-profile");
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

await runTest("delivery profile state trims global profile names consistently", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-trimmed-"));
	try {
		const configDir = path.join(agentDir, "extensions", "delivery-state-machine");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "phase-launches.json"), JSON.stringify({
			defaultProfile: " premium ",
			profiles: {
				" premium ": {
					IMPLEMENT: { agent: "worker", model: "trimmed-impl" },
					VERIFY: { agent: "fresh-verifier", model: "trimmed-verify", context: "fresh" },
					REVIEW: { agent: "reviewer", model: "trimmed-review" },
					CLOSE: { agent: "delegate", model: "trimmed-close" },
					RETRO: { agent: "delegate", model: "trimmed-retro" },
				},
			},
		}, null, 2), "utf8");
		await withProfileEnv(agentDir, () => {
			const state = loadDeliveryProfileState();
			assert.deepEqual(state.profiles, ["premium"]);
			assert.equal(state.defaultProfile, "premium");
			assert.equal(state.activeProfile, "premium");
			assert.equal((state.profileDefinitions.premium.IMPLEMENT as any).model, "trimmed-impl");
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

await runTest("delivery profile API lists and switches global active profile", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-api-root-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-api-agent-"));
	try {
		writeJsonReport(projectRunDir(root), "profile api report");
		writeProfileConfig(agentDir);
		await withProfileEnv(agentDir, async () => {
			await withServer(configFor([root]), async (baseUrl) => {
				const listed = await fetch(`${baseUrl}/api/delivery-profiles/global`);
				assert.equal(listed.status, 200);
				const listedBody = await listed.json() as any;
				assert.deepEqual(listedBody.profiles, ["premium", "cheap"]);
				assert.equal(listedBody.profileDefinitions.premium.IMPLEMENT.model, "premium-impl");
				assert.equal(listedBody.profileDefinitions.cheap.VERIFY.context, "fresh");
				assert.equal(listedBody.activeProfile, "premium");
				assert.equal(listedBody.definitionSource, "global-phase-launches");

				const missingToken = await fetch(`${baseUrl}/api/delivery-profiles/global/active`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ activeProfile: "cheap" }),
				});
				assert.equal(missingToken.status, 400);

				const invalid = await fetch(`${baseUrl}/api/delivery-profiles/global/active`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-report-viewer-token": "test-token" },
					body: JSON.stringify({ activeProfile: "unknown" }),
				});
				assert.equal(invalid.status, 400);

				const malformed = await fetch(`${baseUrl}/api/delivery-profiles/global/active`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-report-viewer-token": "test-token" },
					body: JSON.stringify({ activeProfile: 42 }),
				});
				assert.equal(malformed.status, 400);

				const saved = await fetch(`${baseUrl}/api/delivery-profiles/global/active`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-report-viewer-token": "test-token" },
					body: JSON.stringify({ activeProfile: "cheap" }),
				});
				assert.equal(saved.status, 200);
				const savedBody = await saved.json() as any;
				assert.equal(savedBody.activeProfile, "cheap");
				assert.equal(savedBody.savedActiveProfile, "cheap");
				assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "extensions", "delivery-state-machine", "active-profile.json"), "utf8")), { activeProfile: "cheap" });

				process.env.PI_DELIVERY_PROFILE = "premium";
				const overridden = await fetch(`${baseUrl}/api/delivery-profiles/global`);
				assert.equal(overridden.status, 200);
				const overriddenBody = await overridden.json() as any;
				assert.equal(overriddenBody.activeProfile, "premium");
				assert.equal(overriddenBody.envOverride, true);
				assert.equal(overriddenBody.savedActiveProfile, "cheap");
			});
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

await runTest("delivery profile API rejects malformed saved active profile config", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-malformed-root-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-malformed-agent-"));
	try {
		writeJsonReport(projectRunDir(root), "profile malformed report");
		writeProfileConfig(agentDir);
		const configDir = path.join(agentDir, "extensions", "delivery-state-machine");
		fs.writeFileSync(path.join(configDir, "active-profile.json"), JSON.stringify({}), "utf8");
		await withProfileEnv(agentDir, async () => {
			await withServer(configFor([root]), async (baseUrl) => {
				const response = await fetch(`${baseUrl}/api/delivery-profiles/global`);
				assert.equal(response.status, 400);
				const body = await response.json() as any;
				assert.match(body.error, /invalid activeProfile/);
			});
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

await runTest("delivery profile API surfaces unwritable config directory errors", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-error-root-"));
	const agentFile = path.join(os.tmpdir(), `report-viewer-agent-file-${process.pid}-${Date.now()}`);
	try {
		writeJsonReport(projectRunDir(root), "profile error report");
		fs.writeFileSync(agentFile, "not a directory", "utf8");
		await withProfileEnv(agentFile, async () => {
			await withServer(configFor([root]), async (baseUrl) => {
				const response = await fetch(`${baseUrl}/api/delivery-profiles/global/active`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-report-viewer-token": "test-token" },
					body: JSON.stringify({ activeProfile: "default" }),
				});
				assert.equal(response.status, 400);
				const body = await response.json() as any;
				assert.match(body.error, /ENOTDIR|not a directory|no such file/i);
			});
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agentFile, { force: true });
	}
});

await runTest("reports page renders delivery profile selector", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-ui-root-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-profile-ui-agent-"));
	try {
		writeJsonReport(projectRunDir(root), "profile ui report");
		writeProfileConfig(agentDir);
		await withProfileEnv(agentDir, async () => {
			process.env.PI_DELIVERY_PROFILE = "cheap";
			await withServer(configFor([root]), async (baseUrl) => {
				const response = await fetch(`${baseUrl}/reports`);
				assert.equal(response.status, 200);
				const html = await response.text();
				assert.match(html, /Delivery model profile/);
				assert.match(html, /Environment override active/);
				assert.match(html, /<option value="premium"/);
				assert.match(html, /<option value="cheap" selected/);
				assert.match(html, /Selected profile setup/);
				assert.match(html, /IMPLEMENT/);
				assert.match(html, /cheap-impl/);
				assert.match(html, /cheap-verify/);
			});
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

await runTest("scanReports ignores old flat report directories", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-flat-"));
	try {
		fs.mkdirSync(path.join(root, "flat-run"), { recursive: true });
		fs.writeFileSync(path.join(root, "flat-run", "delivery-report.json"), JSON.stringify({ task: "flat task", status: "DONE" }), "utf8");
		fs.writeFileSync(path.join(root, "flat-run", "00-delivery-summary.md"), "# Delivery summary\n\nTask: flat task\nStatus: DONE\n", "utf8");
		assert.deepEqual(scanReports(configFor([root])), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("migration helper copies a legacy flat report into project layout", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-migrate-"));
	try {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-project-"));
		const legacyDir = path.join(root, "legacy-run");
		fs.mkdirSync(path.join(legacyDir, ".report-viewer"), { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "delivery-report.json"), JSON.stringify({ schemaVersion: 1, id: "legacy-run", task: "flat task", status: "DONE", cwd: projectRoot, gitRoot: projectRoot }, null, 2), "utf8");
		fs.writeFileSync(path.join(legacyDir, "00-delivery-summary.md"), "# Delivery summary\n\nTask: flat task\nStatus: DONE\n", "utf8");
		fs.writeFileSync(path.join(legacyDir, ".report-viewer", "improvements.json"), "[]\n", "utf8");
		assert.deepEqual(scanReports(configFor([root])), []);
		const dryRun = migrateDeliveryReports(root, { dryRun: true, now: new Date("2026-07-05T12:00:00.000Z") });
		assert.equal(dryRun.entries.length, 1);
		assert.equal(fs.existsSync(dryRun.entries[0].destinationPath), false);
		const manifest = migrateDeliveryReports(root, { dryRun: false, now: new Date("2026-07-05T12:00:00.000Z") });
		assert.equal(manifest.entries.length, 1);
		const destination = manifest.entries[0].destinationPath;
		assert.equal(fs.existsSync(path.join(destination, ".report-viewer", "improvements.json")), true);
		const migrated = JSON.parse(fs.readFileSync(path.join(destination, "delivery-report.json"), "utf8"));
		assert.equal(migrated.schemaVersion, 2);
		assert.equal(migrated.project.projectId, manifest.entries[0].projectId);
		const reports = scanReports(configFor([root]));
		assert.equal(reports.length, 1);
		assert.equal(reports[0].task, "flat task");
		assert.equal(reports[0].projectId, manifest.entries[0].projectId);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("scanReports prefers JSON and keeps IDs unique across roots", () => {
	const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-a-"));
	const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-b-"));
	try {
		writeJsonReport(projectRunDir(rootA, "same-name-aaaaaaaa"), "json-backed task");
		writeLegacyReport(projectRunDir(rootB, "same-name-aaaaaaaa"), "legacy task");
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

await runTest("groupReportsByProject groups runs by project and sorts by latest run", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-grouping-"));
	try {
		writeJsonReport(projectRunDir(root, "project-alpha-11111111", "old"), "alpha old task", { updatedAt: 1000 });
		writeJsonReport(projectRunDir(root, "project-alpha-11111111", "new"), "alpha new task", { updatedAt: 3000 });
		writeJsonReport(projectRunDir(root, "project-beta-22222222", "latest"), "beta latest task", { updatedAt: 5000 });
		const groups = groupReportsByProject(scanReports(configFor([root])));
		assert.deepEqual(groups.map((group) => group.projectId), ["project-beta-22222222", "project-alpha-11111111"]);
		assert.equal(groups[0].runCount, 1);
		assert.equal(groups[1].runCount, 2);
		assert.deepEqual(groups[1].reports.map((report) => report.task), ["alpha new task", "alpha old task"]);
		assert.equal(groups[1].projectName, "project-alpha");
		assert.equal(groups[1].gitRemote, "git@example.com:project-alpha-11111111.git");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("reports page groups after applying filters", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-filtered-groups-"));
	try {
		writeJsonReport(projectRunDir(root, "project-alpha-11111111", "alpha"), "alpha visible task", { updatedAt: 1000 });
		writeJsonReport(projectRunDir(root, "project-beta-22222222", "beta"), "beta hidden task", { updatedAt: 2000 });
		await withServer(configFor([root]), async (baseUrl) => {
			const response = await fetch(`${baseUrl}/reports?task=alpha`);
			assert.equal(response.status, 200);
			const html = await response.text();
			assert.match(html, /class="section-card project-group"/);
			assert.match(html, /project-alpha/);
			assert.match(html, /alpha visible task/);
			assert.doesNotMatch(html, /project-beta/);
			assert.doesNotMatch(html, /beta hidden task/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("reports page renders malformed unknown project metadata safely", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-malformed-project-"));
	try {
		const projectId = "unknown-project-33333333";
		const runDir = path.join(root, "projects", projectId, "runs", "run");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(root, "projects", projectId, "project.json"), "{not-json", "utf8");
		writeJsonReport(runDir, "unknown project task", { project: undefined, updatedAt: 1234 });
		const reports = scanReports(configFor([root]));
		assert.equal(reports.length, 1);
		assert.equal(reports[0].projectId, projectId);
		assert.equal(reports[0].projectMetadataSource, "inferred");
		await withServer(configFor([root]), async (baseUrl) => {
			const response = await fetch(`${baseUrl}/reports`);
			assert.equal(response.status, 200);
			const html = await response.text();
			assert.match(html, /Unknown project/);
			assert.match(html, /Project id: <code>unknown-project-33333333<\/code>/);
			assert.match(html, /Metadata incomplete/);
			assert.match(html, /unknown project task/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("loadReport reads structured JSON and renders escaped Markdown", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-load-"));
	try {
		writeLegacyReport(projectRunDir(root, "legacy-project-11111111", "legacy"), "legacy <unsafe> task");
		const [reportSummary] = scanReports(configFor([root]));
		const report = loadReport(configFor([root]), reportSummary.viewerReportId);
		assert.equal(report.source, "legacy-markdown");
		assert.match(report.summaryHtml ?? "", /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(report.summaryHtml ?? "", /<script>/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("renderMarkdownSafe supports safe basic Markdown", () => {
	const html = renderMarkdownSafe("# Heading\n\n- item\n\n```\n<b>x</b>\n```\n\n| A | B |\n|---|---|\n| 1 | <script>bad()</script> |");
	assert.match(html, /<h1>Heading<\/h1>/);
	assert.match(html, /<ul><li>item<\/li><\/ul>/);
	assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
	assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>&lt;script&gt;bad\(\)&lt;\/script&gt;<\/td><\/tr><\/tbody><\/table>/);
	assert.doesNotMatch(html, /<script>/);
});

await runTest("artifact contract parser handles phase fixtures and legacy fallback", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-parser-"));
	try {
		const dir = projectRunDir(root);
		writeJsonReport(dir, "parser task");
		for (const name of ["01-implementation.md", "02-verification.md", "03-review.md", "04-close.md", "05-retro.md"]) {
			const parsed = parseArtifactContract(fs.readFileSync(path.join(dir, name), "utf8"), { artifactPath: name });
			assert.equal(parsed.isContract, true, `${name} follows the contract`);
			assert.ok(parsed.result, `${name} has a RESULT line`);
			assert.ok(parsed.sections.length > 0, `${name} sections parsed`);
		}
		const retro = parseArtifactContract(fs.readFileSync(path.join(dir, "05-retro.md"), "utf8"), { artifactPath: "05-retro.md" });
		assert.equal(retro.retroCandidates[0].title, "Add parser fixtures");
		const fencedOutput = parseArtifactContract("RESULT: PASS\n\n## Summary\nVerifier passed after inspecting output.\n\n## Findings\nnone\n\n## Commands run\n- `npm run verify` - passed\n\n```txt\n## fake heading from command output\nnot a real artifact section\n```\n\n## Behavioral evidence\n- dashboard rendered\n\n## Candidate completeness\n- checked\n\n## Residual risks\nnone\n\n## Recommendation\nnone\n", { artifactPath: "02-verification.md" });
		assert.equal(fencedOutput.isContract, true);
		assert.deepEqual(fencedOutput.sections.map((section) => section.heading), ["Summary", "Findings", "Commands run", "Behavioral evidence", "Candidate completeness", "Residual risks", "Recommendation"]);
		assert.match(fencedOutput.sectionMap["commands run"], /## fake heading from command output/);
		const legacy = parseArtifactContract("PASS legacy verifier output\n\nChecklist: ok\n\nFindings:\n- missing card\n\nValidation commands:\n- `curl /reports` - passed - route rendered\n\nEvidence:\n- user-facing page rendered\n\nResidual risks:\n- visual polish not checked\n\nRecommendation: repair", { artifactPath: "02-verification.md" });
		assert.equal(legacy.result, "PASS");
		assert.equal(legacy.isContract, false);
		assert.equal(legacy.summary, "legacy verifier output");
		assert.deepEqual(legacy.findings, ["missing card"]);
		assert.equal(legacy.commands[0].command, "curl /reports");
		assert.equal(legacy.commands[0].result, "passed");
		assert.deepEqual(legacy.residualRisks, ["visual polish not checked"]);
		assert.equal(legacy.recommendation, "repair");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("UI routes render report list, report detail, and artifact content", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-ui-"));
	try {
		writeJsonReport(projectRunDir(root), "ui route task");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const list = await fetch(`${baseUrl}/reports?source=json&task=route`);
			assert.equal(list.status, 200);
			const listHtml = await list.text();
			assert.match(listHtml, /ui route task/);
			assert.match(listHtml, /Apply filters/);
			assert.match(listHtml, /class="section-card project-group"/);
			assert.match(listHtml, /Project id: <code>project-a-12345678<\/code>/);
			assert.match(listHtml, /Remote: <code>git@example.com:project-a-12345678\.git<\/code>/);
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const detailHtml = await detail.text();
			assert.match(detailHtml, /Phase journey/);
			assert.match(detailHtml, /phase-card/);
			assert.match(detailHtml, /PASS verification evidence/);
			assert.match(detailHtml, /class="phase-groups"/);
			assert.match(detailHtml, /Failures and repairs/);
			assert.match(detailHtml, /Raw structured JSON/);
			const artifact = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("02-verification.md")}`);
			assert.equal(artifact.status, 200);
			const artifactHtml = await artifact.text();
			assert.match(artifactHtml, /PASS verification evidence/);
			assert.match(artifactHtml, /Raw Markdown/);
			const retroArtifact = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("05-retro.md")}`);
			assert.equal(retroArtifact.status, 200);
			const retroHtml = await retroArtifact.text();
			assert.match(retroHtml, /Actionable improvement candidates/);
			assert.match(retroHtml, /Create improvement/);
			assert.match(retroHtml, /05-retro.md/);
			assert.match(retroHtml, new RegExp(`<a href="/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/03-review\\.md">03-review\\.md</a>`));
			const detailWithRetroCandidates = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detailWithRetroCandidates.status, 200);
			const detailWithRetroCandidatesHtml = await detailWithRetroCandidates.text();
			assert.match(detailWithRetroCandidatesHtml, /Actionable improvement candidates/);
			assert.match(detailWithRetroCandidatesHtml, /Add parser fixtures/);
			assert.match(detailWithRetroCandidatesHtml, new RegExp(`<a href="/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/03-review\\.md">03-review\\.md</a>`));
			const malformed = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("malformed.md")}`);
			assert.equal(malformed.status, 200);
			const malformedHtml = await malformed.text();
			assert.match(malformedHtml, /Structured parsing unavailable for this artifact/);
			assert.match(malformedHtml, /class="artifact-sections"/);
			assert.match(malformedHtml, /Raw Markdown/);
			assert.match(malformedHtml, /&lt;script&gt;alert\(&#39;owned&#39;\)&lt;\/script&gt;/);
			assert.doesNotMatch(malformedHtml, /<script>alert\('owned'\)<\/script>/);
			const created = await fetch(`${baseUrl}/api/reports/${encodeURIComponent(summary.viewerReportId)}/improvements`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-report-viewer-token": config.csrfToken },
				body: JSON.stringify({ title: "Add parser fixtures", description: "Keep contract fixtures current", risk: "medium", sourceArtifact: "05-retro.md", sourceText: "| Add parser fixtures | medium | 03-review.md | Keep contract fixtures current |" }),
			});
			assert.equal(created.status, 201);
			const improvement = await created.json();
			assert.equal(improvement.sourceArtifact, "05-retro.md");
			assert.match(improvement.sourceText, /Add parser fixtures/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("report detail shows usage totals at the top and token-only phase usage", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-usage-"));
	try {
		const usageDelta = { input: 180, output: 70, cacheRead: 40, cacheWrite: 10, totalTokens: 300, cost: 0.1234, assistantMessages: 1, sessionFiles: 1 };
		writeJsonReport(projectRunDir(root), "usage overview task", {
			steps: [
				{ id: "IMPLEMENT-1", phase: "IMPLEMENT", attempt: 1, agent: "worker", status: "reported", verdict: "PASS", artifact: "01-implementation.md", summary: "implemented usage cards", startedAt: 1, usageDelta },
			],
			usage: {
				currentSessionTotals: { input: 9999, output: 9999, cacheRead: 9999, cacheWrite: 9999, totalTokens: 39996, cost: 9.9999, assistantMessages: 9, sessionFiles: 9 },
				sinceDeliveryStart: { input: 700, output: 194, cacheRead: 300, cacheWrite: 40, totalTokens: 1234, cost: 0.4321, assistantMessages: 4, sessionFiles: 3 },
				attribution: "best-effort",
			},
		});
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, /id="usage-overview"/);
			assert.match(html, /Total cost[\s\S]*\$0\.4321/);
			assert.match(html, /Total tokens[\s\S]*1,234/);
			assert.match(html, /Input tokens[\s\S]*700/);
			assert.match(html, /Output tokens[\s\S]*194/);
			assert.match(html, /Cache read tokens[\s\S]*300/);
			assert.match(html, /Cache write tokens[\s\S]*40/);
			assert.match(html, /Tokens: 300/);
			assert.match(html, /input 180 \/ output 70 \/ cache read 40 \/ cache write 10/);
			assert.doesNotMatch(html, /Cost: \$0\.1234/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("report detail shows aggregate and individual parallel reviewer artifacts", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-parallel-review-"));
	try {
		const dir = projectRunDir(root);
		writeJsonReport(dir, "parallel reviewer task", {
			steps: [
				{ id: "IMPLEMENT-1", phase: "IMPLEMENT", attempt: 1, agent: "worker", status: "reported", verdict: "PASS", artifact: "01-implementation.md", summary: "implemented", startedAt: 1 },
				{ id: "VERIFY-1", phase: "VERIFY", attempt: 1, agent: "fresh-verifier", status: "reported", verdict: "PASS", artifact: "02-verification.md", summary: "verified", startedAt: 2 },
				{ id: "REVIEW-1-0", phase: "REVIEW", attempt: 1, childIndex: 0, childCount: 2, agent: "reviewer", model: "default", status: "reported", artifact: "03-review-1-01-reviewer.md", startedAt: 3 },
				{ id: "REVIEW-1-1", phase: "REVIEW", attempt: 1, childIndex: 1, childCount: 2, agent: "reviewer", model: "openai/gpt-5.5", status: "reported", artifact: "03-review-1-02-reviewer-openai-gpt-5-5.md", startedAt: 3 },
				{ id: "REVIEW-1-aggregate", phase: "REVIEW", attempt: 1, agent: "aggregate", model: "parent", status: "reported", verdict: "FAIL", artifact: "03-review.md", summary: "Reviewer 1 found a blocker; reviewer 2 passed.", startedAt: 3 },
			],
		});
		fs.writeFileSync(path.join(dir, "03-review-1-01-reviewer.md"), "RESULT: FAIL\n\n## Summary\nReviewer 1 found a blocker.\n\n## Must-fix findings\n- blocker\n\n## Non-blocking notes\nnone\n\n## Evidence reviewed\n- diff\n\n## Risk checks\n- failed\n\n## Recommendation\nrepair\n", "utf8");
		fs.writeFileSync(path.join(dir, "03-review-1-02-reviewer-openai-gpt-5-5.md"), "RESULT: PASS\n\n## Summary\nReviewer 2 passed.\n\n## Must-fix findings\nnone\n\n## Non-blocking notes\nnone\n\n## Evidence reviewed\n- diff\n\n## Risk checks\n- passed\n\n## Recommendation\nnone\n", "utf8");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, /REVIEW #1 reviewer 1\/2/);
			assert.match(html, /REVIEW #1 reviewer 2\/2/);
			assert.match(html, /REVIEW #1 aggregate/);
			assert.match(html, /03-review-1-01-reviewer\.md/);
			assert.match(html, /03-review-1-02-reviewer-openai-gpt-5-5\.md/);
			assert.match(html, /03-review\.md/);
			assert.match(html, /<span class="badge bad">FAIL<\/span>/);
			assert.match(html, /<span class="badge ok">PASS<\/span>/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("report list compacts long titles and exposes full task on detail", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-long-title-"));
	try {
		const longTask = "Deliver the approved report viewer readability and artifact link reliability plan with a deliberately verbose title that should not dominate the dashboard rows";
		writeJsonReport(projectRunDir(root), longTask);
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const list = await fetch(`${baseUrl}/reports?task=readability`);
			assert.equal(list.status, 200);
			const listHtml = await list.text();
			assert.match(listHtml, /class="report-list"/);
			assert.match(listHtml, /class="report-row"/);
			assert.match(listHtml, /title="Deliver the approved report viewer readability/);
			assert.match(listHtml, /Deliver the approved report viewer readability and artifact link reliability plan with a…/);
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const detailHtml = await detail.text();
			assert.match(detailHtml, /Full delivery task/);
			assert.match(detailHtml, /deliberately verbose title that should not dominate/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("artifact links handle referenced absolutes, externals, missing refs, and unsafe schemes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-artifact-links-root-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-artifact-links-outside-"));
	try {
		const dir = projectRunDir(root);
		const absoluteArtifact = path.join(outside, "absolute implementation.md");
		const unreferencedArtifact = path.join(outside, "unreferenced.md");
		const absoluteSymlink = path.join(outside, "absolute-link.md");
		const windowsArtifact = "C:/report-viewer/windows-artifact.md";
		const windowsUnreferenced = "C:/report-viewer/unreferenced.md";
		fs.writeFileSync(absoluteArtifact, "RESULT: PASS\n\n## Summary\nAbsolute artifact summary.\n", "utf8");
		fs.writeFileSync(unreferencedArtifact, "RESULT: PASS\n\n## Summary\nUnreferenced artifact.\n", "utf8");
		fs.symlinkSync(absoluteArtifact, absoluteSymlink);
		writeJsonReport(dir, "artifact link task", {
			steps: [
				{ id: "IMPLEMENT-abs", phase: "IMPLEMENT", attempt: 1, agent: "worker", status: "reported", artifact: absoluteArtifact, summary: "generic implementation summary", startedAt: 1 },
				{ id: "VERIFY-multi", phase: "VERIFY", attempt: 1, agent: "fresh-verifier", status: "reported", verdict: "PASS", artifact: "02-verification.md; missing-detail.md; review notes #1.md", summary: "generic verify summary", startedAt: 2 },
				{ id: "REVIEW-external", phase: "REVIEW", attempt: 1, agent: "reviewer", status: "reported", verdict: "PASS", artifact: "https://example.com/review.md", summary: "external review", startedAt: 3 },
				{ id: "REVIEW-unsafe", phase: "REVIEW", attempt: 2, agent: "reviewer", status: "reported", verdict: "PASS", artifact: "javascript:alert(1)", summary: "unsafe review", startedAt: 4 },
				{ id: "REVIEW-file", phase: "REVIEW", attempt: 3, agent: "reviewer", status: "reported", verdict: "PASS", artifact: "file:///etc/passwd", summary: "file url", startedAt: 5 },
				{ id: "REVIEW-windows", phase: "REVIEW", attempt: 4, agent: "reviewer", status: "reported", verdict: "PASS", artifact: windowsArtifact, summary: "windows absolute reference", startedAt: 6 },
				{ id: "CLOSE-symlink", phase: "CLOSE", attempt: 1, agent: "delegate", status: "reported", artifact: absoluteSymlink, summary: "absolute symlink", startedAt: 7 },
			],
		});
		fs.writeFileSync(path.join(dir, "review notes #1.md"), "RESULT: PASS\n\n## Summary\nSpecial character artifact opened.\n", "utf8");
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, /Absolute artifact summary/);
			assert.match(html, /Artifact 1/);
			assert.match(html, /missing-detail\.md/);
			assert.match(html, /Artifact 2 unavailable: Artifact not found/);
			assert.match(html, /href="https:\/\/example\.com\/review\.md" rel="noreferrer"/);
			assert.match(html, /Unsupported artifact URL scheme/);
			assert.doesNotMatch(html, /href="javascript:alert\(1\)"/);
			assert.doesNotMatch(html, /href="file:\/\/\/etc\/passwd"/);
			assert.match(html, /C:&#x2F;report-viewer&#x2F;windows-artifact\.md|C:\/report-viewer\/windows-artifact\.md/);
			assert.match(html, /Artifact not found/);
			assert.match(html, /Absolute artifact symlinks are not allowed/);

			const absolute = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent(absoluteArtifact)}`);
			assert.equal(absolute.status, 200);
			assert.match(await absolute.text(), /Absolute artifact summary/);
			const special = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("review notes #1.md")}`);
			assert.equal(special.status, 200);
			assert.match(await special.text(), /Special character artifact opened/);
			const unreferenced = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent(unreferencedArtifact)}`);
			assert.equal(unreferenced.status, 400);
			assert.match(await unreferenced.text(), /not referenced/);
			const proxiedExternal = await fetch(`${baseUrl}/api/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("https://example.com/review.md")}`);
			assert.equal(proxiedExternal.status, 400);
			assert.match(await proxiedExternal.text(), /External artifacts are not proxied/);
			const unsafe = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent("javascript:alert(1)")}`);
			assert.equal(unsafe.status, 400);
			assert.match(await unsafe.text(), /Unsupported artifact URL scheme/);
			const referencedWindows = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent(windowsArtifact)}`);
			assert.equal(referencedWindows.status, 400);
			assert.match(await referencedWindows.text(), /Artifact not found/);
			const unreferencedWindows = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent(windowsUnreferenced)}`);
			assert.equal(unreferencedWindows.status, 400);
			assert.match(await unreferencedWindows.text(), /not referenced/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

await runTest("semicolon-bearing external artifact URLs are not split", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-external-semicolon-"));
	try {
		const dir = projectRunDir(root);
		const externalArtifact = "https://example.com/a;b/report.md";
		writeJsonReport(dir, "external semicolon artifact task", {
			steps: [
				{ id: "REVIEW-external-semicolon", phase: "REVIEW", attempt: 1, agent: "reviewer", status: "reported", verdict: "PASS", artifact: externalArtifact, summary: "external semicolon review", startedAt: 1 },
			],
		});
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, /href="https:\/\/example\.com\/a;b\/report\.md" rel="noreferrer"/);
			assert.doesNotMatch(html, /Artifact 1/);
			assert.doesNotMatch(html, /Artifact 2/);
			assert.doesNotMatch(html, /unavailable: Artifact not found/);
			const proxiedExternal = await fetch(`${baseUrl}/api/reports/${encodeURIComponent(summary.viewerReportId)}/artifacts/${encodeURIComponent(externalArtifact)}`);
			assert.equal(proxiedExternal.status, 400);
			assert.match(await proxiedExternal.text(), /External artifacts are not proxied/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("artifact verdict detection allows referenced absolutes and blocks relative symlink escapes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-unsafe-verdict-root-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-unsafe-verdict-outside-"));
	try {
		const dir = projectRunDir(root);
		const secretPath = path.join(outside, "secret-review.md");
		writeJsonReport(dir, "unsafe artifact verdict task", {
			steps: [
				{ id: "REVIEW-absolute", phase: "REVIEW", attempt: 1, agent: "reviewer", status: "reported", artifact: secretPath, summary: "absolute out-of-report artifact", startedAt: 1 },
				{ id: "REVIEW-symlink", phase: "REVIEW", attempt: 1, agent: "reviewer", status: "reported", artifact: "secret-review-link.md", summary: "symlink out-of-report artifact", startedAt: 2 },
			],
		});
		fs.writeFileSync(secretPath, "RESULT: FAIL\n\n## Summary\nOut-of-report secret verdict.\n", "utf8");
		fs.symlinkSync(secretPath, path.join(dir, "secret-review-link.md"));
		const config = configFor([root]);
		const [summary] = scanReports(config);
		await withServer(config, async (baseUrl) => {
			const list = await fetch(`${baseUrl}/reports?task=unsafe`);
			assert.equal(list.status, 200);
			const listHtml = await list.text();
			assert.match(listHtml, /Failed verify\/review: REVIEW #1/);
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const html = await detail.text();
			assert.match(html, /Out-of-report secret verdict/);
			assert.match(html, /symlink out-of-report artifact/);
			assert.match(html, /<span class="badge bad">FAIL<\/span>/);
			assert.match(html, /Artifact path escapes configured report roots/);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

await runTest("report detail groups repeated phase attempts and report list highlights risks", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-signals-"));
	try {
		const reportDir = projectRunDir(root);
		writeJsonReport(reportDir, "signals task", {
			acceptedRisks: ["accepted launch risk"],
			steps: [
				{ id: "IMPLEMENT-1", phase: "IMPLEMENT", attempt: 1, agent: "worker", status: "reported", verdict: "PASS", artifact: "01-implementation.md", summary: "initial implementation", startedAt: 1 },
				{ id: "VERIFY-1", phase: "VERIFY", attempt: 1, agent: "fresh-verifier", status: "reported", verdict: "FAIL", artifact: "02-verification.md", summary: "missing grouped phase attempts", startedAt: 2 },
				{ id: "IMPLEMENT-2", phase: "IMPLEMENT", attempt: 2, agent: "worker", status: "reported", verdict: "PASS", artifact: "01-implementation-2.md", summary: "repair grouped repeated attempts", startedAt: 3 },
				{ id: "VERIFY-2", phase: "VERIFY", attempt: 2, agent: "fresh-verifier", status: "reported", verdict: "PASS", artifact: "02-verification-2.md", summary: "verify passed", startedAt: 4 },
				{ id: "REVIEW-1", phase: "REVIEW", attempt: 1, agent: "reviewer", status: "reported", verdict: "FAIL", artifact: "03-review.md", summary: "report list missing risk cues", startedAt: 5 },
				{ id: "REVIEW-2", phase: "REVIEW", attempt: 2, agent: "reviewer", status: "reported", verdict: "PASS", artifact: "03-review-2.md", summary: "review passed", startedAt: 6 },
			],
		});
		const config = configFor([root]);
		const [summary] = scanReports(config);
		const improvement = createImprovement(config, summary.viewerReportId, {
			title: "Follow up on retro finding",
			description: "Create an app-owned improvement from retro evidence.",
		});
		decideImprovement(config, summary.viewerReportId, improvement.id, "approved", "ready to run");
		await withServer(config, async (baseUrl) => {
			const list = await fetch(`${baseUrl}/reports?task=signals`);
			assert.equal(list.status, 200);
			const listHtml = await list.text();
			assert.match(listHtml, /Failed verify\/review: VERIFY #1, REVIEW #1/);
			assert.match(listHtml, /Accepted risks: 1/);
			assert.match(listHtml, /Retro improvements: 1/);
			assert.match(listHtml, /Retro candidates: 1/);
			assert.match(listHtml, /Pending improvement runs: 1/);
			const detail = await fetch(`${baseUrl}/reports/${encodeURIComponent(summary.viewerReportId)}`);
			assert.equal(detail.status, 200);
			const detailHtml = await detail.text();
			assert.match(detailHtml, /VERIFY attempts \(2\)/);
			assert.match(detailHtml, /REVIEW attempts \(2\)/);
			assert.match(detailHtml, /Repair loop: 2 attempts recorded\./);
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("state-changing API routes require the local CSRF token", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-csrf-"));
	try {
		writeJsonReport(projectRunDir(root), "csrf task");
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
		const reportDir = projectRunDir(root);
		writeJsonReport(reportDir, "path safety task");
		fs.writeFileSync(path.join(outside, "secret.md"), "secret", "utf8");
		fs.symlinkSync(path.join(outside, "secret.md"), path.join(reportDir, "secret-link.md"));
		const [summary] = scanReports(configFor([root]));
		const allowed = resolveArtifactPath(configFor([root]), summary.viewerReportId, "02-verification.md");
		assert.equal(allowed.kind, "local");
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, "../run/02-verification.md"), /traversal/i);
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, "%2e%2e/run/02-verification.md"), /traversal/i);
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, path.join(outside, "secret.md")), /not referenced/i);
		assert.throws(() => resolveArtifactPath(configFor([root]), summary.viewerReportId, "secret-link.md"), /escapes/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

await runTest("improvement approval metadata is stored separately and unapproved runs are rejected", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-viewer-improvements-"));
	try {
		const reportDir = projectRunDir(root);
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
		const reportDir = projectRunDir(root);
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
		const reportDir = projectRunDir(root);
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
