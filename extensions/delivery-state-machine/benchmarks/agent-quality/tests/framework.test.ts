import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadScenarios } from "../catalog.ts";
import { provisionScenario, runtimeEnvironment, snapshot } from "../provision.ts";
import DeliveryAgentProvider, { gradePromptfooOutput, runPromptfooTrial, runScenario, type RuntimeExecutor } from "../run.ts";
import { artifactPrompt, credentialValuesFromAuthFile, executePiRuntime, publicEvidenceChoiceContract, resolveChild, selectAuthentication, spawnBounded, validateOuterLaunch } from "../runtime.ts";
import { scoreMutation } from "../scorers/index.ts";
import { PROMPTFOO_VERSION, validateResult, validateScenario, type NormalizedResult, type ScenarioRecord } from "../schema.ts";

function command(program: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
	return execFileSync(program, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function artifact(scenario: ScenarioRecord, evidence: unknown = scenario.artifact.expectedEvidence, verdict = scenario.expected.verdict): string {
	return [
		`RESULT: ${verdict}`,
		...scenario.artifact.headings.flatMap((heading) => ["", heading, `- deterministic fake evidence: ${scenario.artifact.requiredEvidence.join(", ")}`]),
		"",
		"```eval-evidence",
		JSON.stringify(evidence, null, 2),
		"```",
	].join("\n") + "\n";
}

function fakeRuntime(scenario: ScenarioRecord, candidate: string, run: Parameters<RuntimeExecutor>[2]) {
	const sessionFile = path.join(run.rawEvidence, "fake-child.jsonl");
	const metadataFile = path.join(run.rawEvidence, "fake-child-metadata.json");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: run.workspace })}\n`);
	fs.writeFileSync(metadataFile, `${JSON.stringify({ runId: "fake", childIndex: 0, agent: candidate })}\n`);
	const effective = { agent: candidate, provider: "fake", model: scenario.launch.model, thinking: scenario.launch.thinking, context: scenario.launch.context, tools: scenario.launch.tools, cwd: run.workspace, sessionFile, metadataFile };
	return {
		evidence: { requested: { agent: candidate, model: scenario.launch.model, thinking: scenario.launch.thinking, context: scenario.launch.context, tools: scenario.launch.tools, cwd: run.workspace, output: run.artifactPath }, effective, started: true, completed: true, timedOut: false, infrastructureErrors: [] },
		outer: { provider: "fake", model: scenario.launch.model, usage: { inputTokens: 1, outputTokens: 1 } },
		child: effective,
	};
}

const successfulFake: RuntimeExecutor = async (scenario, candidate, run) => {
	if (scenario.id === "IMP-01") {
		fs.writeFileSync(path.join(run.workspace, "src/cache.mjs"), `const cache = new Map();\nconst key = (id, tenant) => tenant === undefined ? id : tenant + "\\0" + id;\nexport function remember(id, value, tenant) { cache.set(key(id, tenant), value); return value; }\nexport function recall(id, tenant) { return cache.get(key(id, tenant)); }\nexport function clear() { cache.clear(); }\n`);
	}
	if (scenario.id === "IMP-02") fs.writeFileSync(path.join(run.workspace, "lib/range.mjs"), "export function inclusiveRange(start, end) { return Array.from({length: Math.max(0, end - start + 1)}, (_, index) => start + index); }\n");
	if (scenario.id === "CLO-01") {
		command("git", ["add", "candidate.txt"], run.workspace, run.env);
		command("git", ["-c", "user.name=Fake", "-c", "user.email=fake@example.invalid", "commit", "-qm", "close candidate"], run.workspace, run.env);
		command("git", ["push", "-q", "origin", "main"], run.workspace, run.env);
		command("gh", ["pr", "create", "--title", "fixture"], run.workspace, run.env);
	}
	fs.writeFileSync(run.artifactPath, artifact(scenario));
	return fakeRuntime(scenario, candidate, run);
};

const scenarios = loadScenarios();
assert.equal(scenarios.length, 10);
assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 10);
assert.equal(PROMPTFOO_VERSION, "0.121.19");

const ver02ControlScenario = scenarios.find((entry) => entry.id === "VER-02")!;
const ver02ControlRun = provisionScenario(ver02ControlScenario);
try {
	assert.equal(command("node", ["controls/supported.mjs"], ver02ControlRun.workspace, { ...process.env, TMPDIR: ver02ControlRun.workspace }), "pass");
	assert.equal(scoreMutation(ver02ControlScenario, ver02ControlRun.workspace, ver02ControlRun.before).passed, true, "actual VER-02 control must leave no workspace mutation when TMPDIR is the workspace");
} finally { ver02ControlRun.cleanup(); }

let representativeResult: NormalizedResult | undefined;
for (const scenario of scenarios) {
	const result = await runScenario({ scenario, candidate: scenario.candidates[0], executor: successfulFake, retain: false });
	representativeResult ??= result;
	assert.equal(result.status, "PASS", `${scenario.id}: ${JSON.stringify(result.scorers)}`);
	assert.equal(result.scorers.filter((entry) => entry.critical && !entry.passed).length, 0);
	assert.equal(fs.existsSync(result.rawEvidencePath), false, "temporary evidence must be cleaned");
}
assert.ok(representativeResult);
for (const mutate of [
	(value: any) => { delete value.candidateCommit; },
	(value: any) => { delete value.outer.provider; },
	(value: any) => { value.scorers = []; },
	(value: any) => { delete value.child.metadataFile; },
	(value: any) => { value.startedAt = "not-a-timestamp"; },
	(value: any) => { value.status = "INFRASTRUCTURE_FAILURE"; },
	(value: any) => { value.unexpected = true; },
]) {
	const malformed = structuredClone(representativeResult);
	mutate(malformed);
	assert.throws(() => validateResult(malformed));
}

const unsafeCases: Array<(scenario: any) => void> = [
	(value) => { value.candidates = ["unknown", "worker"]; },
	(value) => { value.fixture.path = "../escape"; },
	(value) => { value.remote = { policy: "local-only", url: "https://github.com/real/repo", prStub: true }; },
	(value) => { value.environment = { inherit: true, allow: [] }; },
	(value) => { delete value.expected; },
	(value) => { delete value.mutation; },
	(value) => { delete value.artifact.expectedEvidence; },
];
for (const mutate of unsafeCases) {
	const value = structuredClone(scenarios[0]);
	mutate(value);
	assert.throws(() => validateScenario(value));
}

const invalidArtifact: RuntimeExecutor = async (scenario, candidate, run) => {
	const runtime = await successfulFake(scenario, candidate, run);
	fs.writeFileSync(run.artifactPath, "RESULT: PASS\n\n## Summary\nunsupported success\n");
	return runtime;
};
const candidateFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-01")!, candidate: "dsm.verifier", executor: invalidArtifact, retain: false });
assert.equal(candidateFailure.status, "CANDIDATE_FAILURE");
assert.equal(candidateFailure.scorers.find((entry) => entry.name === "artifact")?.passed, false);

let postRuntimeFailureRoot = "";
const postRuntimeSecret = "post-runtime-secret-must-be-redacted-123456";
const postRuntimeFailure: RuntimeExecutor = async (scenario, candidate, run) => {
	postRuntimeFailureRoot = run.root;
	run.secretValues.push(postRuntimeSecret);
	fs.writeFileSync(path.join(run.rawEvidence, "pre-failure.txt"), `${postRuntimeSecret}\navailable before evidence failure\n`);
	fs.rmSync(path.join(run.workspace, ".git"), { recursive: true, force: true });
	return fakeRuntime(scenario, candidate, run);
};
const postRuntimeFailureResult = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: postRuntimeFailure, retain: true });
try {
	assert.equal(postRuntimeFailureResult.status, "INFRASTRUCTURE_FAILURE");
	assert.equal(postRuntimeFailureResult.scorers.every((entry) => !entry.critical || !entry.passed), true, "post-runtime evidence failure must remain unscored");
	assert.match(postRuntimeFailureResult.diagnostics.join(" "), /post-runtime evidence failure/);
	assert.equal(JSON.stringify(postRuntimeFailureResult).includes(postRuntimeSecret), false, "normalized failure result must sanitize lifecycle secrets");
	assert.equal(postRuntimeFailureResult.redactionPassed, false, "retained pre-failure evidence containing a secret must be detected and redacted");
	assert.equal(fs.readFileSync(path.join(postRuntimeFailureResult.rawEvidencePath, "runtime", "pre-failure.txt"), "utf8").includes(postRuntimeSecret), false);
	assert.match(fs.readFileSync(path.join(postRuntimeFailureResult.rawEvidencePath, "runtime", "pre-failure.txt"), "utf8"), /\[REDACTED\]/);
} finally { fs.rmSync(postRuntimeFailureResult.rawEvidencePath, { recursive: true, force: true }); }
assert.ok(postRuntimeFailureRoot, "post-runtime failure must capture the disposable run root");
assert.equal(fs.existsSync(postRuntimeFailureRoot), false, "post-runtime evidence failure must clean the repository and credential-bearing agent home");

const partialProvisionParent = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-partial-provision-"));
try {
	const partialProvisionFailure = await runScenario({
		scenario: scenarios.find((entry) => entry.id === "VER-02")!,
		candidate: "dsm.verifier",
		retain: false,
		provisioner: (scenario) => provisionScenario({ ...scenario, fixture: { ...scenario.fixture, path: "missing-fixture" } }, partialProvisionParent),
	});
	assert.equal(partialProvisionFailure.status, "INFRASTRUCTURE_FAILURE");
	assert.equal(partialProvisionFailure.completion, "launch_failed");
	assert.match(partialProvisionFailure.diagnostics.join(" "), /scenario provisioning failed/);
	assert.deepEqual(fs.readdirSync(partialProvisionParent), [], "partial provisioning must remove the repository and credential-bearing agent home");
} finally { fs.rmSync(partialProvisionParent, { recursive: true, force: true }); }

const provisioningEnvironmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-provision-env-"));
const hostCredentialName = "OPENAI_API_KEY";
const hostCredential = "allowlisted-model-key-must-not-leak-123456";
const previousHostCredential = process.env[hostCredentialName];
try {
	const fixtureRoot = path.join(provisioningEnvironmentRoot, "fixtures");
	for (const name of ["success", "failure"]) fs.mkdirSync(path.join(fixtureRoot, name), { recursive: true });
	fs.writeFileSync(path.join(fixtureRoot, "success", "candidate.txt"), "candidate\n");
	fs.writeFileSync(path.join(fixtureRoot, "success", "setup.sh"), `printf '%s' "\${${hostCredentialName}-unset}" > setup-observation.txt\n`);
	fs.writeFileSync(path.join(fixtureRoot, "failure", "candidate.txt"), "candidate\n");
	fs.writeFileSync(path.join(fixtureRoot, "failure", "setup.sh"), `printf '%s\\n' "\${${hostCredentialName}-unset}" >&2\nprintf '%s\\n' ${JSON.stringify(hostCredential)} >&2\nexit 7\n`);
	process.env[hostCredentialName] = hostCredential;
	const baseScenario = scenarios.find((entry) => entry.id === "VER-02")!;
	const isolatedSetup = provisionScenario({ ...baseScenario, fixture: { ...baseScenario.fixture, path: "success" } }, provisioningEnvironmentRoot, fixtureRoot);
	try {
		assert.equal(fs.readFileSync(path.join(isolatedSetup.workspace, "setup-observation.txt"), "utf8"), "unset", "setup must not inherit an allowlisted model credential before the runtime boundary");
		assert.equal(hostCredentialName in isolatedSetup.env, false);
		assert.equal(runtimeEnvironment(isolatedSetup.env, baseScenario.environment.allow)[hostCredentialName], hostCredential, "model credential must be added only by the runtime-boundary environment builder");
		assert.equal(JSON.stringify([...isolatedSetup.before.entries()]).includes(hostCredential), false);
	} finally { isolatedSetup.cleanup(); }
	assert.throws(
		() => provisionScenario({ ...baseScenario, fixture: { ...baseScenario.fixture, path: "failure" } }, provisioningEnvironmentRoot, fixtureRoot),
		(error: unknown) => error instanceof Error && /scenario provisioning failed/.test(error.message) && !error.message.includes(hostCredential),
		"provisioning failure diagnostics must sanitize allowlisted model credentials even if fixture stderr contains the value",
	);
	const isolatedControlScenario = { ...baseScenario, controls: { focused: [`test -z "$${hostCredentialName}"`], behavior: [] } };
	const isolatedControlResult = await runScenario({ scenario: isolatedControlScenario, candidate: "dsm.verifier", executor: successfulFake, retain: false });
	assert.equal(isolatedControlResult.status, "PASS", "scoring controls must not inherit allowlisted runtime credentials");
} finally {
	if (previousHostCredential === undefined) delete process.env[hostCredentialName]; else process.env[hostCredentialName] = previousHostCredential;
	fs.rmSync(provisioningEnvironmentRoot, { recursive: true, force: true });
}

const fixtureIntegrityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-fixture-integrity-"));
try {
	const baseScenario = scenarios.find((entry) => entry.id === "VER-02")!;
	const temporaryFixtures = path.join(fixtureIntegrityRoot, "fixtures");
	const temporarySource = path.join(temporaryFixtures, baseScenario.fixture.path);
	const outsideSentinel = path.join(temporaryFixtures, "outside-preservation.txt");
	fs.mkdirSync(temporaryFixtures, { recursive: true });
	fs.cpSync(path.resolve("extensions/delivery-state-machine/benchmarks/agent-quality/fixtures", baseScenario.fixture.path), temporarySource, { recursive: true });
	fs.writeFileSync(outsideSentinel, "unrelated sibling must be preserved\n");
	const originalSnapshot = snapshot(temporarySource);
	const mutatingFixture: RuntimeExecutor = async (scenario, candidate, run) => {
		fs.writeFileSync(run.artifactPath, artifact(scenario));
		const displacedFixture = `${run.fixtureSource}-candidate-copy`;
		fs.renameSync(run.fixtureSource, displacedFixture);
		fs.cpSync(displacedFixture, run.fixtureSource, { recursive: true });
		fs.writeFileSync(path.join(run.fixtureSource, "UNSUPPORTED.md"), "mutated outside workspace\n");
		fs.rmSync(path.join(run.fixtureSource, "lib", "write.mjs"));
		fs.writeFileSync(path.join(run.fixtureSource, "ADDED.md"), "unapproved addition\n");
		fs.chmodSync(path.join(run.fixtureSource, "controls", "supported.mjs"), 0o600);
		// Reproduce REVIEW-13's predictable sibling-backup attack. Production authority must not live here.
		const obsoleteBackup = path.join(run.root, "fixture-source-backup");
		assert.equal(fs.existsSync(obsoleteBackup), false, "authoritative restoration material must not exist in the candidate-accessible run root");
		fs.mkdirSync(obsoleteBackup, { recursive: true });
		fs.writeFileSync(path.join(obsoleteBackup, "UNSUPPORTED.md"), "corrupt obsolete backup\n");
		return fakeRuntime(scenario, candidate, run);
	};
	const fixtureMutation = await runScenario({
		scenario: baseScenario,
		candidate: "dsm.verifier",
		executor: mutatingFixture,
		provisioner: (scenario) => provisionScenario(scenario, fixtureIntegrityRoot, temporaryFixtures),
		retain: false,
	});
	assert.equal(fixtureMutation.status, "CANDIDATE_FAILURE", "out-of-workspace source-fixture mutation must fail the candidate");
	assert.match(fixtureMutation.scorers.find((entry) => entry.name === "mutation")?.detail ?? "", /immutable source fixture changed/);
	assert.deepEqual(snapshot(temporarySource), originalSnapshot, "production cleanup must restore modified, deleted, added, and chmod-mutated fixture entries even when the candidate corrupts the obsolete sibling-backup path");
	assert.equal(fs.existsSync(`${temporarySource}-candidate-copy`), false, "production cleanup must remove the candidate-created path holding the displaced original fixture identity");
	assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "unrelated sibling must be preserved\n", "fixture restoration must not overwrite paths outside the fixture root");

	const failingAfterMutation: RuntimeExecutor = async (scenario, candidate, run) => {
		await mutatingFixture(scenario, candidate, run);
		fs.rmSync(path.join(run.workspace, ".git"), { recursive: true, force: true });
		return fakeRuntime(scenario, candidate, run);
	};
	const normalizedEvidenceFailure = await runScenario({
		scenario: baseScenario,
		candidate: "dsm.verifier",
		executor: failingAfterMutation,
		provisioner: (scenario) => provisionScenario(scenario, fixtureIntegrityRoot, temporaryFixtures),
		retain: false,
	});
	assert.equal(normalizedEvidenceFailure.status, "INFRASTRUCTURE_FAILURE", "post-runtime evidence failure must be normalized rather than reject");
	assert.match(normalizedEvidenceFailure.diagnostics.join(" "), /post-runtime evidence failure/);
	assert.deepEqual(snapshot(temporarySource), originalSnapshot, "primary execution failure must not bypass source-fixture restoration");
	assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "unrelated sibling must be preserved\n");

	const restorationFailure = await runScenario({
		scenario: baseScenario,
		candidate: "dsm.verifier",
		executor: mutatingFixture,
		provisioner: (scenario) => {
			const run = provisionScenario(scenario, fixtureIntegrityRoot, temporaryFixtures);
			const restoreFixture = run.restoreFixture;
			run.restoreFixture = () => {
				restoreFixture();
				throw new Error("simulated immutable source fixture restoration failure");
			};
			return run;
		},
		retain: false,
	});
	assert.equal(restorationFailure.status, "INFRASTRUCTURE_FAILURE", "fixture restoration failure must override candidate status as cleanup infrastructure failure");
	assert.equal(restorationFailure.scorers.filter((entry) => entry.critical && entry.passed).length, 0, "cleanup infrastructure failure must not retain candidate scorer passes");
	assert.ok(restorationFailure.scorers.filter((entry) => entry.critical).every((entry) => /not evaluated because cleanup failed/.test(entry.detail)));
	assert.match(restorationFailure.diagnostics.join(" "), /cleanup failure: simulated immutable source fixture restoration failure/);
	assert.deepEqual(snapshot(temporarySource), originalSnapshot, "a restoration failure reported after copying must still leave the fixture preserved");
	assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "unrelated sibling must be preserved\n");

	const successfulCleanupFailure = await runScenario({
		scenario: baseScenario,
		candidate: "dsm.verifier",
		executor: successfulFake,
		provisioner: (scenario) => {
			const run = provisionScenario(scenario, fixtureIntegrityRoot, temporaryFixtures);
			const cleanup = run.cleanup;
			run.cleanup = () => {
				cleanup();
				throw new Error("simulated cleanup I/O failure after removal");
			};
			return run;
		},
		retain: false,
	});
	assert.equal(successfulCleanupFailure.status, "INFRASTRUCTURE_FAILURE");
	assert.equal(successfulCleanupFailure.scorers.filter((entry) => entry.critical && entry.passed).length, 0, "an otherwise-successful candidate must retain no candidate score after cleanup infrastructure failure");
	assert.ok(successfulCleanupFailure.scorers.filter((entry) => entry.critical).every((entry) => /not evaluated because cleanup failed/.test(entry.detail)));
	assert.match(successfulCleanupFailure.diagnostics.join(" "), /simulated cleanup I\/O failure/);

	let retryFailedRestore: (() => void) | undefined;
	let stateBeforeFailedRestore: Map<string, { sha256: string; mode: number }> | undefined;
	const actualPreSwapFailure = await runScenario({
		scenario: baseScenario,
		candidate: "dsm.verifier",
		executor: async (scenario, candidate, run) => {
			const runtime = await mutatingFixture(scenario, candidate, run);
			stateBeforeFailedRestore = snapshot(temporarySource);
			fs.chmodSync(temporaryFixtures, 0o555);
			return runtime;
		},
		provisioner: (scenario) => {
			const run = provisionScenario(scenario, fixtureIntegrityRoot, temporaryFixtures);
			retryFailedRestore = run.restoreFixture;
			return run;
		},
		retain: false,
	}).finally(() => fs.chmodSync(temporaryFixtures, 0o755));
	assert.equal(actualPreSwapFailure.status, "INFRASTRUCTURE_FAILURE", "a genuine pre-swap filesystem denial must be a cleanup infrastructure failure");
	assert.match(actualPreSwapFailure.diagnostics.join(" "), /cleanup failure/);
	assert.ok(stateBeforeFailedRestore);
	assert.deepEqual(snapshot(temporarySource), stateBeforeFailedRestore, "failed pre-swap restoration must not destructively worsen the existing source tree");
	assert.ok(retryFailedRestore);
	retryFailedRestore();
	assert.deepEqual(snapshot(temporarySource), originalSnapshot, "the parent-memory authority must remain independently usable after disposable-root cleanup");

	const provisioningFailureSource = path.join(temporaryFixtures, "provision-failure");
	fs.mkdirSync(provisioningFailureSource);
	const provisioningFailureSentinel = path.join(provisioningFailureSource, "sentinel.txt");
	fs.writeFileSync(provisioningFailureSentinel, "original\n", { mode: 0o644 });
	fs.writeFileSync(path.join(provisioningFailureSource, "setup.sh"), `printf 'mutated\\n' > ${JSON.stringify(provisioningFailureSentinel)}\nchmod 600 ${JSON.stringify(provisioningFailureSentinel)}\nprintf 'added\\n' > ${JSON.stringify(path.join(provisioningFailureSource, "added.txt"))}\nexit 9\n`, { mode: 0o755 });
	const provisioningFailureSnapshot = snapshot(provisioningFailureSource);
	const provisioningFailure = await runScenario({
		scenario: { ...baseScenario, fixture: { ...baseScenario.fixture, path: "provision-failure" } },
		candidate: "dsm.verifier",
		provisioner: (scenario) => provisionScenario(scenario, fixtureIntegrityRoot, temporaryFixtures),
		retain: false,
	});
	assert.equal(provisioningFailure.status, "INFRASTRUCTURE_FAILURE");
	assert.deepEqual(snapshot(provisioningFailureSource), provisioningFailureSnapshot, "partial provisioning failure must restore its source fixture before deleting the backup");
	assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "unrelated sibling must be preserved\n");
} finally { fs.rmSync(fixtureIntegrityRoot, { recursive: true, force: true }); }

const semanticOpposite: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, { classification: "pass", issue: "missing-record-rename-is-safe" }));
	return fakeRuntime(scenario, candidate, run);
};
const semanticFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "REV-01")!, candidate: "dsm.reviewer", executor: semanticOpposite, retain: false });
assert.equal(semanticFailure.status, "CANDIDATE_FAILURE");
assert.match(semanticFailure.scorers.find((entry) => entry.name === "artifact")?.detail ?? "", /known outcome/);

const hiddenOutcomeScenario = scenarios.find((entry) => entry.id === "REV-01")!;
const publicPrompt = artifactPrompt(hiddenOutcomeScenario, { artifactPath: "/fixture/artifact.md" } as any);
assert.match(publicPrompt, /"classification": "<string>"/);
assert.match(publicPrompt, /"safeguardGap": "<string>"/);
assert.match(publicPrompt, /Public bounded choices/);
assert.match(publicPrompt, /the scorer's expected choice remains hidden/);
assert.doesNotMatch(publicPrompt, /required terms/i);
for (const expectedChoice of Object.values(hiddenOutcomeScenario.artifact.expectedEvidence)) {
	assert.equal(publicPrompt.includes(JSON.stringify(expectedChoice)), true, `public bounded contract omitted a satisfiable choice: ${String(expectedChoice)}`);
}
function selectChoicePosition(contract: any, position: number): unknown {
	if (contract && typeof contract === "object" && Array.isArray(contract.choices)) return contract.choices[position] ?? contract.choices[0];
	return Object.fromEntries(Object.entries(contract).map(([key, value]) => [key, selectChoicePosition(value, position)]));
}
for (const scenario of scenarios) {
	const fixedPositionEvidence = selectChoicePosition(publicEvidenceChoiceContract(scenario), 0);
	const fixedPositionCopy: RuntimeExecutor = async (current, candidate, run) => {
		await successfulFake(current, candidate, run);
		fs.writeFileSync(run.artifactPath, artifact(current, fixedPositionEvidence));
		return fakeRuntime(current, candidate, run);
	};
	const fixedPositionResult = await runScenario({ scenario, candidate: scenario.candidates[0], executor: fixedPositionCopy, retain: false });
	assert.equal(fixedPositionResult.scorers.find((entry) => entry.name === "artifact")?.passed, false, `${scenario.id}: blindly choosing the first public option must not pass`);
}
const blindTemplateCopy: RuntimeExecutor = async (scenario, candidate, run) => {
	const placeholders = Object.fromEntries(Object.keys(scenario.artifact.expectedEvidence).map((key) => [key, "<string>"]));
	fs.writeFileSync(run.artifactPath, artifact(scenario, placeholders));
	return fakeRuntime(scenario, candidate, run);
};
const blindCopyFailure = await runScenario({ scenario: hiddenOutcomeScenario, candidate: "dsm.reviewer", executor: blindTemplateCopy, retain: false });
assert.equal(blindCopyFailure.status, "CANDIDATE_FAILURE");
assert.match(blindCopyFailure.scorers.find((entry) => entry.name === "artifact")?.detail ?? "", /known outcome/);

const independentlySelectedRevEvidence: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, {
		classification: "must-fix",
		issue: "missing-record-rename-deletes-destination",
		reproducer: "controls/data-loss.mjs",
		safeguardGap: "shallow-tests-miss-supported-sequence",
	}));
	return fakeRuntime(scenario, candidate, run);
};
const independentlySelectedRevPass = await runScenario({ scenario: hiddenOutcomeScenario, candidate: "dsm.reviewer", executor: independentlySelectedRevEvidence, retain: false });
assert.equal(independentlySelectedRevPass.status, "PASS", "a child can select correct evidence from the public bounded contract without hidden scorer terms");

const cleanRev02 = scenarios.find((entry) => entry.id === "REV-02")!;
const cleanRev02Pass: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, {
		classification: "pass",
		supportedModel: "single-writer",
		excludedConcern: "none",
	}, "PASS"));
	return fakeRuntime(scenario, candidate, run);
};
const cleanRev02Result = await runScenario({ scenario: cleanRev02, candidate: "dsm.reviewer", executor: cleanRev02Pass, retain: false });
assert.equal(cleanRev02Result.status, "PASS", "REV-02 must accept a justified clean PASS as well as PASS_WITH_NON_BLOCKING_NOTES");
const notesRev02Result = await runScenario({ scenario: cleanRev02, candidate: "dsm.reviewer", executor: successfulFake, retain: false });
assert.equal(notesRev02Result.status, "PASS", "REV-02 must retain its PASS_WITH_NON_BLOCKING_NOTES outcome");

const independentlyDerivedEvidence: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, {
		classification: "accepted",
		supportedModel: "single-writer exclusive creation",
		excludedConcern: "hostile mutation and concurrent writers",
	}));
	return fakeRuntime(scenario, candidate, run);
};
const independentlyDerivedPass = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: independentlyDerivedEvidence, retain: false });
assert.equal(independentlyDerivedPass.status, "PASS");

const realCanaryEvidence: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, {
		classification: "supported",
		supportedModel: "single-writer exclusive creation",
		excludedConcern: "hostile mutation and concurrent writers",
	}));
	return fakeRuntime(scenario, candidate, run);
};
const realCanaryEvidencePass = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: realCanaryEvidence, retain: false });
assert.equal(realCanaryEvidencePass.status, "PASS");
const passWithNotesEvidence: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, {
		classification: "pass-with-non-blocking-notes",
		supportedModel: "single-writer",
		excludedConcern: "concurrent-writers",
	}));
	return fakeRuntime(scenario, candidate, run);
};
const passWithNotesEvidencePass = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: passWithNotesEvidence, retain: false });
assert.equal(passWithNotesEvidencePass.status, "PASS");

const contradictoryEvidence: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario, {
		classification: "accepted",
		supportedModel: "not single-writer",
		excludedConcern: "not concurrent-writers",
	}));
	return fakeRuntime(scenario, candidate, run);
};
const contradictionFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: contradictoryEvidence, retain: false });
assert.equal(contradictionFailure.status, "CANDIDATE_FAILURE");
assert.match(contradictionFailure.scorers.find((entry) => entry.name === "artifact")?.detail ?? "", /known outcome/);

const launchScenario = scenarios.find((entry) => entry.id === "VER-02")!;
const requestedLaunch = { agent: "dsm.verifier", model: launchScenario.launch.model, thinking: launchScenario.launch.thinking, context: launchScenario.launch.context, tools: launchScenario.launch.tools, cwd: "/fixture", output: "/fixture/artifact.md" };
const parentLaunchEntries = (model: string) => [{ message: { role: "assistant", content: [{ type: "toolCall", name: "subagent", arguments: { agent: requestedLaunch.agent, model, context: requestedLaunch.context, cwd: requestedLaunch.cwd, output: requestedLaunch.output } }] } }];
assert.deepEqual(validateOuterLaunch(parentLaunchEntries(`${requestedLaunch.model}:${requestedLaunch.thinking}`), requestedLaunch), []);
assert.match(validateOuterLaunch(parentLaunchEntries(requestedLaunch.model), requestedLaunch).join(" "), /model\/thinking/);
assert.match(validateOuterLaunch(parentLaunchEntries(`${requestedLaunch.model}:off`), requestedLaunch).join(" "), /model\/thinking/);

const toolMismatch: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(run.artifactPath, artifact(scenario));
	const runtime = fakeRuntime(scenario, candidate, run);
	runtime.effective.tools = ["read"];
	return runtime;
};
const toolFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: toolMismatch, retain: false });
assert.equal(toolFailure.status, "INFRASTRUCTURE_FAILURE");
assert.match(toolFailure.scorers.find((entry) => entry.name === "runtime")?.detail ?? "", /tools/);

const transientGitOperation: RuntimeExecutor = async (scenario, candidate, run) => {
	fs.writeFileSync(path.join(run.workspace, "lib/range.mjs"), "export function inclusiveRange(start, end) { return Array.from({length: Math.max(0, end - start + 1)}, (_, index) => start + index); }\n");
	command("git", ["add", "lib/range.mjs"], run.workspace, run.env);
	command("git", ["reset"], run.workspace, run.env);
	fs.writeFileSync(run.artifactPath, artifact(scenario));
	return fakeRuntime(scenario, candidate, run);
};
const transientGitFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "IMP-02")!, candidate: "dsm.implementer", executor: transientGitOperation, retain: false });
assert.equal(transientGitFailure.status, "CANDIDATE_FAILURE");
assert.match(transientGitFailure.scorers.find((entry) => entry.name === "git")?.detail ?? "", /forbidden Git operation attempted/);

const emptyClose: RuntimeExecutor = async (scenario, candidate, run) => {
	command("git", ["-c", "user.name=Fake", "-c", "user.email=fake@example.invalid", "commit", "--allow-empty", "-qm", "empty close"], run.workspace, run.env);
	command("git", ["push", "-q", "origin", "main"], run.workspace, run.env);
	command("gh", ["status"], run.workspace, run.env);
	fs.writeFileSync(run.artifactPath, artifact(scenario));
	return fakeRuntime(scenario, candidate, run);
};
const emptyCloseFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "CLO-01")!, candidate: "dsm.closer", executor: emptyClose, retain: false });
assert.equal(emptyCloseFailure.status, "CANDIDATE_FAILURE");
assert.match(emptyCloseFailure.scorers.find((entry) => entry.name === "git")?.detail ?? "", /commit tree|commit paths|not clean|valid PR/);

const noOpPush: RuntimeExecutor = async (scenario, candidate, run) => {
	command("git", ["push", "-q", "origin", "main"], run.workspace, run.env);
	fs.writeFileSync(run.artifactPath, artifact(scenario));
	return fakeRuntime(scenario, candidate, run);
};
const noOpPushFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "CLO-02")!, candidate: "dsm.closer", executor: noOpPush, retain: false });
assert.equal(noOpPushFailure.status, "CANDIDATE_FAILURE");
assert.match(noOpPushFailure.scorers.find((entry) => entry.name === "git")?.detail ?? "", /forbidden Git operation attempted: push/);

const infrastructureFailure = await runScenario({ scenario: scenarios[0], candidate: scenarios[0].candidates[0], executor: async () => { throw new Error("provider quota unavailable"); }, retain: false });
assert.equal(infrastructureFailure.status, "INFRASTRUCTURE_FAILURE");
assert.match(infrastructureFailure.diagnostics.join(" "), /quota unavailable/);

const boundaryOptions = { scenario: scenarios[0], candidate: scenarios[0].candidates[0], retain: false };
let retrySequence = [structuredClone(infrastructureFailure), structuredClone(representativeResult)];
const recoveredProvider = new DeliveryAgentProvider({ config: { maxInfrastructureAttempts: 3 } }, async () => retrySequence.shift()!);
const recoveredResponse = await recoveredProvider.callApi("ignored", { vars: { scenarioId: scenarios[0].id, candidate: scenarios[0].candidates[0] } });
assert.ok(recoveredResponse.output);
const recoveredResult = validateResult(JSON.parse(recoveredResponse.output));
assert.equal(recoveredResult.status, "PASS", "a candidate result after an infrastructure retry must retain ordinary PASS behavior");
assert.equal(recoveredResult.harness?.classification, "scored");
assert.equal(recoveredResult.harness?.finalAttempt, 2);
assert.deepEqual(recoveredResult.harness?.attempts.map((attempt) => attempt.status), ["INFRASTRUCTURE_FAILURE", "PASS"]);
assert.match(recoveredResult.harness?.attempts[0].diagnostics.join(" ") ?? "", /quota unavailable/);
assert.equal(recoveredResponse.metadata.unscored, false);
assert.deepEqual(gradePromptfooOutput(recoveredResponse.output), { pass: true, score: 1, reason: "candidate trial passed" });

for (const infrastructureReason of ["provider quota unavailable", "authentication unavailable", "runtime dependency unavailable", "cleanup failure"] as const) {
	let calls = 0;
	const provider = new DeliveryAgentProvider({ config: { maxInfrastructureAttempts: 3 } }, async () => {
		calls++;
		if (calls === 2) return structuredClone(representativeResult);
		const result = structuredClone(infrastructureFailure);
		result.diagnostics = [infrastructureReason];
		return result;
	});
	const response = await provider.callApi("ignored", { vars: { scenarioId: scenarios[0].id, candidate: scenarios[0].candidates[0] } });
	assert.equal(calls, 2, `${infrastructureReason} must trigger one bounded rerun`);
	assert.ok(response.output);
	const result = validateResult(JSON.parse(response.output));
	assert.equal(result.status, "PASS");
	assert.equal(result.harness?.attempts[0].diagnostics[0], infrastructureReason);
	assert.equal(result.harness?.attempts[1].status, "PASS");
}

let exhaustedCalls = 0;
const exhaustedProvider = new DeliveryAgentProvider({ config: { maxInfrastructureAttempts: 3 } }, async () => {
	exhaustedCalls++;
	const result = structuredClone(infrastructureFailure);
	result.rawEvidencePath = `/retained/infrastructure-attempt-${exhaustedCalls}`;
	result.diagnostics = [`provider quota unavailable attempt ${exhaustedCalls}`];
	result.outer.usage = { inputTokens: exhaustedCalls, outputTokens: exhaustedCalls + 1 };
	return result;
});
const exhaustedResponse = await exhaustedProvider.callApi("ignored", { vars: { scenarioId: scenarios[0].id, candidate: scenarios[0].candidates[0] } });
assert.equal(exhaustedCalls, 3, "infrastructure retries must be deterministically bounded");
assert.equal(exhaustedResponse.output, undefined, "exhausted infrastructure must not reach candidate assertions as output");
assert.match(exhaustedResponse.error ?? "", /UNSCORED_INFRASTRUCTURE_FAILURE after 3 attempt/);
const exhaustedResult = validateResult((exhaustedResponse.metadata.result as NormalizedResult));
assert.equal(exhaustedResult.status, "INFRASTRUCTURE_FAILURE");
assert.equal(exhaustedResult.harness?.classification, "infrastructure_exhausted");
assert.equal(exhaustedResult.harness?.finalAttempt, 3);
assert.deepEqual(exhaustedResult.harness?.attempts.map((attempt) => attempt.rawEvidencePath), [
	"/retained/infrastructure-attempt-1", "/retained/infrastructure-attempt-2", "/retained/infrastructure-attempt-3",
]);
assert.deepEqual(exhaustedResult.harness?.attempts.map((attempt) => attempt.outer.usage?.inputTokens), [1, 2, 3]);
assert.equal(exhaustedResponse.metadata.unscored, true);
assert.throws(() => gradePromptfooOutput(JSON.stringify(exhaustedResult)), /must be returned as a Promptfoo provider error/);

const promptfooBoundaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-promptfoo-boundary-"));
try {
	const providerFile = path.join(promptfooBoundaryRoot, "provider.mjs");
	const configFile = path.join(promptfooBoundaryRoot, "promptfooconfig.yaml");
	const outputFile = path.join(promptfooBoundaryRoot, "results.json");
	fs.writeFileSync(providerFile, `export default class StubInfrastructureProvider { id() { return "stub-infrastructure"; } async callApi() { return ${JSON.stringify({ error: exhaustedResponse.error, metadata: exhaustedResponse.metadata })}; } }\n`);
	fs.writeFileSync(configFile, [
		"prompts: [boundary]",
		"providers:",
		`  - id: file://${providerFile}`,
		"tests:",
		"  - assert:",
		"      - type: javascript",
		"        value: \"JSON.parse(output).status === 'PASS'\"",
		"",
	].join("\n"));
	const promptfoo = spawnSync(path.resolve("node_modules/.bin/promptfoo"), ["eval", "-c", configFile, "--no-cache", "--output", outputFile], {
		cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../"),
		env: { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_CONFIG_DIR: path.join(promptfooBoundaryRoot, "config") },
		encoding: "utf8",
	});
	assert.equal(promptfoo.status, 100, `Promptfoo exhausted-infrastructure run must stop as an error, not succeed or candidate-fail: ${promptfoo.stderr}`);
	const promptfooOutput = JSON.parse(fs.readFileSync(outputFile, "utf8"));
	const boundaryResult = promptfooOutput.results.results[0];
	assert.match(boundaryResult.error, /UNSCORED_INFRASTRUCTURE_FAILURE/);
	assert.equal(boundaryResult.gradingResult, null, "candidate assertion must not run for exhausted infrastructure");
	assert.equal(promptfooOutput.results.prompts[0].metrics.testFailCount, 0, "infrastructure must not increment candidate failure count");
	assert.equal(promptfooOutput.results.prompts[0].metrics.testErrorCount, 1, "exhausted infrastructure must remain in Promptfoo's error bucket");
	assert.equal(boundaryResult.response.metadata.classification, "infrastructure_exhausted");
	assert.equal(boundaryResult.response.metadata.result.harness.attempts.length, 3);
} finally { fs.rmSync(promptfooBoundaryRoot, { recursive: true, force: true }); }

let candidateBoundaryCalls = 0;
const candidateProvider = new DeliveryAgentProvider({ config: { maxInfrastructureAttempts: 3 } }, async () => {
	candidateBoundaryCalls++;
	return structuredClone(candidateFailure);
});
const candidateResponse = await candidateProvider.callApi("ignored", { vars: { scenarioId: scenarios[0].id, candidate: scenarios[0].candidates[0] } });
assert.equal(candidateBoundaryCalls, 1, "candidate failures must not be retried as infrastructure");
assert.ok(candidateResponse.output);
assert.equal(validateResult(JSON.parse(candidateResponse.output)).harness?.classification, "scored");
assert.deepEqual(gradePromptfooOutput(candidateResponse.output), { pass: false, score: 0, reason: "candidate trial failed deterministic checks" });

await assert.rejects(() => runPromptfooTrial(boundaryOptions, 0, async () => structuredClone(infrastructureFailure)), /maxInfrastructureAttempts/);
const frameworkRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const promptfooConfig = fs.readFileSync(path.join(frameworkRoot, "promptfooconfig.yaml"), "utf8");
assert.match(promptfooConfig, /repeat: 1/, "developer matrix must default to one repetition");
assert.match(promptfooConfig, /maxConcurrency: 1/, "model trials must remain serial");
assert.match(promptfooConfig, /maxInfrastructureAttempts: 3/);
assert.match(promptfooConfig, /provider boundary must expose exhausted infrastructure as a Promptfoo error/);
assert.doesNotMatch(promptfooConfig, /JSON\.parse\(output\)\.status === 'PASS'/);
const packageScripts = JSON.parse(fs.readFileSync(path.resolve(frameworkRoot, "../../../../package.json"), "utf8")).scripts as Record<string, string>;
for (const name of ["smoke", "implement", "verify", "review", "close", "retro", "full"]) {
	assert.equal(typeof packageScripts[`eval:dsm-agents:${name}`], "string", `missing developer eval script: ${name}`);
}
assert.match(packageScripts["eval:dsm-agents:full"], /--repeat 3/, "full matrix must opt into three repetitions");

const scorerCrash: RuntimeExecutor = async (scenario, candidate, run) => {
	const runtime = await successfulFake(scenario, candidate, run);
	fs.symlinkSync("lib", path.join(run.workspace, "unexpected-link"));
	return runtime;
};
const scorerFailure = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: scorerCrash, retain: false });
assert.equal(scorerFailure.status, "INFRASTRUCTURE_FAILURE");
assert.match(scorerFailure.diagnostics.join(" "), /scorer mutation crashed/);

const noUsage: RuntimeExecutor = async (scenario, candidate, run) => {
	const runtime = await successfulFake(scenario, candidate, run);
	delete runtime.child!.usage;
	return runtime;
};
const usageWarning = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: noUsage, retain: false });
assert.equal(usageWarning.status, "PASS");
assert.equal(usageWarning.scorers.find((entry) => entry.name === "usage")?.available, false);

const joinScenario = scenarios.find((entry) => entry.id === "VER-02")!;
const provisioned = provisionScenario(joinScenario);
try {
	const requested = { agent: "dsm.verifier", model: joinScenario.launch.model, thinking: joinScenario.launch.thinking, context: joinScenario.launch.context, tools: joinScenario.launch.tools, cwd: provisioned.workspace, output: provisioned.artifactPath };
	const metadata = path.join(provisioned.workspace, ".pi-subagents", "artifacts");
	const metadataFile = path.join(metadata, "joined_agent_0_meta.json");
	const childTask = `Write your findings to exactly this path: ${requested.output}\nThis path is authoritative for this run.`;
	fs.mkdirSync(metadata, { recursive: true });
	fs.writeFileSync(metadataFile, JSON.stringify({ runId: "joined", agent: requested.agent, model: requested.model, thinking: requested.thinking, cwd: requested.cwd, task: childTask }));
	const session = path.join(provisioned.env.PI_CODING_AGENT_DIR, "sessions", "joined", "run-0", "session.jsonl");
	fs.mkdirSync(path.dirname(session), { recursive: true });
	fs.writeFileSync(session, [
		JSON.stringify({ type: "session", cwd: requested.cwd }),
		JSON.stringify({ type: "model_change", provider: "fake", modelId: requested.model }),
		JSON.stringify({ type: "thinking_level_change", thinkingLevel: requested.thinking }),
		JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `Task: ${childTask}` }] } }),
		JSON.stringify({ message: { role: "assistant", stopReason: "stop", usage: { input: 2, output: 3 } } }),
	].join("\n") + "\n");
	const joined = resolveChild(provisioned, requested, requested.tools);
	assert.equal(joined?.sessionFile, session);
	assert.equal(joined?.metadataFile, metadataFile);
	assert.equal(joined?.context, "fresh");
	assert.equal(joined?.usage?.inputTokens, 2);
	const authoritativeSession = fs.readFileSync(session, "utf8");
	const nonFreshEntries = authoritativeSession.trimEnd().split("\n").map((line) => JSON.parse(line));
	const firstUser = nonFreshEntries.find((entry) => entry?.message?.role === "user");
	firstUser.message.content[0].text = `Task: unrelated inherited history\n\n${childTask}`;
	fs.writeFileSync(session, `${nonFreshEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	assert.throws(() => resolveChild(provisioned, requested, requested.tools), /context could not be proven as fresh/, "requested context must never be copied when authoritative session history disagrees");
	fs.writeFileSync(session, authoritativeSession);
	fs.writeFileSync(path.join(metadata, "joined_duplicate_0_meta.json"), JSON.stringify({ runId: "joined", agent: requested.agent, task: `Write your findings to exactly this path: ${requested.output}\nThis path is authoritative for this run.` }));
	assert.throws(() => resolveChild(provisioned, requested, requested.tools), /expected one child metadata match/);
} finally { provisioned.cleanup(); }

const retainedEvidence = await runScenario({ scenario: joinScenario, candidate: "dsm.verifier", executor: successfulFake, retain: true });
try {
	assert.equal(retainedEvidence.status, "PASS");
	assert.ok(retainedEvidence.child?.metadataFile);
	assert.equal(path.dirname(retainedEvidence.child!.metadataFile), retainedEvidence.rawEvidencePath);
	assert.equal(fs.existsSync(retainedEvidence.child!.metadataFile), true, "authoritative child metadata must survive temporary-root cleanup");
	assert.equal(JSON.parse(fs.readFileSync(retainedEvidence.child!.metadataFile, "utf8")).agent, "dsm.verifier");
} finally { fs.rmSync(retainedEvidence.rawEvidencePath, { recursive: true, force: true }); }

const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-auth-"));
try {
	const authFile = path.join(authRoot, "auth.json");
	const authSecret = "fixture-access-token-123456";
	fs.writeFileSync(authFile, JSON.stringify({
		"openai-codex": { type: "oauth", access: authSecret, refresh: "fixture-refresh-token-654321", accountId: "not-a-secret" },
		anthropic: { type: "oauth", access: "unrelated-anthropic-secret-123456", refresh: "unrelated-anthropic-refresh-654321" },
	}));
	assert.deepEqual(credentialValuesFromAuthFile(authFile).sort(), [authSecret, "fixture-refresh-token-654321", "unrelated-anthropic-secret-123456", "unrelated-anthropic-refresh-654321"].sort());
	const selectedAuth = selectAuthentication(authFile, ["openai-codex/gpt-5.6-sol"]);
	assert.deepEqual(selectedAuth.providers, ["openai-codex"]);
	assert.ok(selectedAuth.contents);
	assert.deepEqual(Object.keys(JSON.parse(selectedAuth.contents!)), ["openai-codex"]);
	assert.equal(selectedAuth.contents!.includes("unrelated-anthropic"), false, "unrelated provider credentials must not reach the isolated agent home");
	assert.deepEqual(selectedAuth.secretValues.sort(), [authSecret, "fixture-refresh-token-654321"].sort());
	const leakingRuntime: RuntimeExecutor = async (scenario, candidate, run) => {
		fs.writeFileSync(run.artifactPath, artifact(scenario));
		fs.writeFileSync(path.join(run.rawEvidence, "leaked-auth.txt"), authSecret);
		return { ...fakeRuntime(scenario, candidate, run), secretValues: [authSecret] };
	};
	const leaked = await runScenario({ scenario: joinScenario, candidate: "dsm.verifier", executor: leakingRuntime, retain: false });
	assert.equal(leaked.status, "INFRASTRUCTURE_FAILURE");
	assert.equal(leaked.redactionPassed, false);
	assert.match(leaked.diagnostics.join(" "), /credential material required redaction/);
	assert.equal(JSON.stringify(leaked).includes(authSecret), false, "normalized result must not retain auth-file credentials");
	const normalizedSecret = "normalized-secret-123456789";
	const normalizedLeakRuntime: RuntimeExecutor = async (scenario, candidate, run) => {
		fs.writeFileSync(run.artifactPath, artifact(scenario));
		const runtime = fakeRuntime(scenario, candidate, run);
		runtime.evidence.infrastructureErrors.push(`provider failed with ${normalizedSecret}`);
		return { ...runtime, secretValues: [normalizedSecret] };
	};
	const normalizedLeak = await runScenario({ scenario: joinScenario, candidate: "dsm.verifier", executor: normalizedLeakRuntime, retain: false });
	assert.equal(JSON.stringify(normalizedLeak).includes(normalizedSecret), false, "diagnostics and scorer details must be sanitized");
	assert.match(JSON.stringify(normalizedLeak), /\[REDACTED\]/);

	const malformedRuntime = path.join(authRoot, "malformed-pi");
	fs.writeFileSync(malformedRuntime, `#!/bin/bash\nmkdir -p "$PI_CODING_AGENT_DIR/sessions/malformed"\nprintf '{"type":"session"\\n' > "$PI_CODING_AGENT_DIR/sessions/malformed/session.jsonl"\nprintf '%s\\n' ${JSON.stringify(authSecret)} >&2\n`, { mode: 0o755 });
	const previousAuthFile = process.env.PI_AGENT_AUTH_FILE;
	const previousPiBin = process.env.PI_BIN;
	process.env.PI_AGENT_AUTH_FILE = authFile;
	process.env.PI_BIN = malformedRuntime;
	let malformedEvidence: NormalizedResult | undefined;
	try {
		malformedEvidence = await runScenario({ scenario: joinScenario, candidate: "dsm.verifier", executor: executePiRuntime, retain: true });
	} finally {
		if (previousAuthFile === undefined) delete process.env.PI_AGENT_AUTH_FILE; else process.env.PI_AGENT_AUTH_FILE = previousAuthFile;
		if (previousPiBin === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = previousPiBin;
	}
	assert.ok(malformedEvidence);
	try {
		assert.equal(malformedEvidence.status, "INFRASTRUCTURE_FAILURE");
		const retainedStderr = path.join(malformedEvidence.rawEvidencePath, "runtime", "outer.stderr.txt");
		const stderr = fs.readFileSync(retainedStderr, "utf8");
		assert.equal(stderr.includes(authSecret), false, "selected credentials must not survive malformed runtime evidence");
		assert.equal(JSON.stringify(malformedEvidence).includes(authSecret), false, "selected credentials must not survive normalized evidence");
		if (malformedEvidence.redactionPassed) {
			// Some supported hosts close the malformed runtime before its final
			// stderr write is retained. No redaction is required when the secret
			// never entered retained evidence.
			assert.doesNotMatch(malformedEvidence.diagnostics.join(" "), /credential material required redaction/);
		} else {
			assert.match(malformedEvidence.diagnostics.join(" "), /credential material required redaction/);
			assert.match(stderr, /\[REDACTED\]/);
		}
	} finally { fs.rmSync(malformedEvidence.rawEvidencePath, { recursive: true, force: true }); }
} finally { fs.rmSync(authRoot, { recursive: true, force: true }); }

const cancellationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-cancel-"));
try {
	const pidFile = path.join(cancellationRoot, "pid");
	const bounded = await spawnBounded("bash", ["-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`], { cwd: cancellationRoot, env: { ...process.env } as Record<string, string>, timeoutMs: 100, stdout: path.join(cancellationRoot, "out"), stderr: path.join(cancellationRoot, "err") });
	assert.equal(bounded.timedOut, true);
	const pid = Number(fs.readFileSync(pidFile, "utf8"));
	await Bun.sleep(100);
	assert.throws(() => process.kill(pid, 0));
} finally { fs.rmSync(cancellationRoot, { recursive: true, force: true }); }

const listenerRestorationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-listener-restore-"));
const preservedSignalListener = () => {};
process.on("SIGTERM", preservedSignalListener);
try {
	await spawnBounded("true", [], { cwd: listenerRestorationRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 5_000, stdout: path.join(listenerRestorationRoot, "out"), stderr: path.join(listenerRestorationRoot, "err") });
	assert.equal(process.listeners("SIGTERM").includes(preservedSignalListener), true, "normal completion must restore pre-existing signal listeners");
} finally {
	process.off("SIGTERM", preservedSignalListener);
	fs.rmSync(listenerRestorationRoot, { recursive: true, force: true });
}

const externalCancellationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-external-cancel-"));
try {
	const runtimeModule = path.resolve("extensions/delivery-state-machine/benchmarks/agent-quality/runtime.ts");
	for (const [signal, expectedExit] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
		const caseRoot = path.join(externalCancellationRoot, signal.toLowerCase());
		fs.mkdirSync(caseRoot, { recursive: true });
		const driver = path.join(caseRoot, "driver.ts");
		const pidFile = path.join(caseRoot, "pid");
		const listenerMarker = path.join(caseRoot, "host-listener.txt");
		fs.writeFileSync(driver, `import { spawnSync } from "node:child_process";\nimport { readFileSync, writeFileSync } from "node:fs";\nimport { spawnBounded } from ${JSON.stringify(runtimeModule)};\nconst signal = ${JSON.stringify(signal)};\nprocess.on(signal, () => {\n  const pid = Number(readFileSync(${JSON.stringify(pidFile)}, "utf8"));\n  const check = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });\n  const state = check.status === 0 ? check.stdout.trim() : "";\n  writeFileSync(${JSON.stringify(listenerMarker)}, state === "" || state.startsWith("Z") ? "clean" : "live:" + state);\n  process.exit(${expectedExit});\n});\nawait spawnBounded("bash", ["-c", ${JSON.stringify(`trap '' HUP INT TERM; echo $$ > ${pidFile}; while :; do sleep 1; done`)}], { cwd: ${JSON.stringify(caseRoot)}, env: { ...process.env }, timeoutMs: 60_000, stdout: ${JSON.stringify(path.join(caseRoot, "out"))}, stderr: ${JSON.stringify(path.join(caseRoot, "err"))} });\n`);
		const host = Bun.spawn([process.execPath, driver], { cwd: caseRoot, stdout: "ignore", stderr: "ignore" });
		for (let attempt = 0; attempt < 200 && !fs.existsSync(pidFile); attempt++) await Bun.sleep(10);
		assert.equal(fs.existsSync(pidFile), true, `${signal} external-cancellation child did not start`);
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		process.kill(host.pid, signal);
		await Bun.sleep(50);
		process.kill(host.pid, signal);
		assert.equal(await host.exited, expectedExit, `runner must restore the host ${signal} listener after cleanup`);
		assert.equal(fs.readFileSync(listenerMarker, "utf8"), "clean", `${signal} host listener ran before process-group cleanup`);
		let state = "";
		try { state = command("ps", ["-o", "stat=", "-p", String(pid)], caseRoot); } catch {}
		assert.ok(state === "" || state.startsWith("Z"), `${signal} cancellation left descendant ${pid} live (${state})`);
	}
} finally { fs.rmSync(externalCancellationRoot, { recursive: true, force: true }); }

const mixedSignalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-agent-eval-mixed-signals-"));
try {
	const runtimeModule = path.resolve("extensions/delivery-state-machine/benchmarks/agent-quality/runtime.ts");
	const driver = path.join(mixedSignalRoot, "driver.ts");
	const pidFile = path.join(mixedSignalRoot, "pid");
	const marker = path.join(mixedSignalRoot, "signals.txt");
	fs.writeFileSync(driver, `import { appendFileSync } from "node:fs";\nimport { spawnBounded } from ${JSON.stringify(runtimeModule)};\nfor (const [signal, mark] of [["SIGHUP", "H"], ["SIGTERM", "T"], ["SIGINT", "I"]]) process.on(signal, () => appendFileSync(${JSON.stringify(marker)}, mark));\nawait spawnBounded("bash", ["-c", ${JSON.stringify(`trap '' HUP INT TERM; echo $$ > ${pidFile}; while :; do sleep 1; done`)}], { cwd: ${JSON.stringify(mixedSignalRoot)}, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 60_000, stdout: ${JSON.stringify(path.join(mixedSignalRoot, "out"))}, stderr: ${JSON.stringify(path.join(mixedSignalRoot, "err"))} });\n`);
	const host = Bun.spawn([process.execPath, driver], { cwd: mixedSignalRoot, stdout: "ignore", stderr: "ignore" });
	for (let attempt = 0; attempt < 200 && !fs.existsSync(pidFile); attempt++) await Bun.sleep(10);
	assert.equal(fs.existsSync(pidFile), true, "mixed-signal child did not start");
	for (const signal of ["SIGHUP", "SIGTERM", "SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
		process.kill(host.pid, signal);
		await Bun.sleep(100);
	}
	assert.equal(await host.exited, 0, "non-exiting embedded listeners must regain control after cleanup");
	assert.equal(fs.readFileSync(marker, "utf8"), "HTIT", "all mixed and repeated signals must replay in observation order");
} finally { fs.rmSync(mixedSignalRoot, { recursive: true, force: true }); }

const first = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: successfulFake, retain: false });
const second = await runScenario({ scenario: scenarios.find((entry) => entry.id === "VER-02")!, candidate: "dsm.verifier", executor: successfulFake, retain: false });
assert.deepEqual(first.scorers, second.scorers, "offline scoring must normalize deterministically");

console.log("agent-quality framework tests passed");
