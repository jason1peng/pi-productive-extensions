import * as fs from "node:fs";
import { artifactPrompt } from "../agent-quality/runtime.ts";
import type { NormalizedResult, ScenarioRecord } from "../agent-quality/schema.ts";
import type { ProvisionedRun } from "../agent-quality/provision.ts";
import { canonicalJson, hashObject, type ManifestRow, type ModelIdentity } from "./schema.ts";

export interface PrelaunchBinding {
	phase: string; renderedPromptHash: string; promptContractHash: string; expectedToolsHash: string; fixtureHash: string; scorerHash: string; routesHash: string;
	outerRequested: { provider: string; model: string; version: string; family: string; thinking: string; context: "fresh" };
	sealHash: string;
}
export interface ObservedExecutionBinding extends PrelaunchBinding {
	child: { agent: string; provider: string; model: string; version: string; family: string; thinking: string; context: string; tools: string[]; toolsHash: string };
	outer: { provider: string; model: string; version: string; family: string; thinking: string; context: "fresh" };
}

export function exactModelId(model: string): string { return model.includes("/") ? model.split("/").slice(1).join("/") : model; }
export function observedVersion(model: string): string { return exactModelId(model); }
export function observedFamily(model: string): string {
	const exact = exactModelId(model); const match = exact.match(/^(gpt-\d+(?:\.\d+)?)/i);
	if (!match) throw new Error(`model family is not derivable from authoritative model id: ${exact}`);
	return match[1].toLowerCase();
}
function normalizeDynamic(text: string): string { return text.replace(/sha256:[a-f0-9]{64}/g, "sha256:<INBOUND_HASH>").replace(/CONSUMED_INBOUND:\s+sha256:<INBOUND_HASH>\s+path:\S+/g, "CONSUMED_INBOUND: sha256:<INBOUND_HASH> path:<INBOUND_REF>").replace(/read\s+\.delivery-evidence\/\S+/g, "read <INBOUND_REF>"); }
function normalizeRenderedPrompt(prompt: string, run: ProvisionedRun): string {
	let normalized = normalizeDynamic(prompt);
	for (const [value, token] of [[run.artifactPath, "<ARTIFACT_PATH>"], [run.workspace, "<WORKSPACE>"], [run.root, "<RUN_ROOT>"], [run.agentHome, "<AGENT_HOME>"], [run.env.TMPDIR ?? "", "<TMPDIR>"]] as Array<[string, string]>) if (value) normalized = normalized.split(value).join(token);
	return normalized;
}
function sealContent(binding: PrelaunchBinding | Omit<PrelaunchBinding, "sealHash">): unknown { const { sealHash: _, ...content } = binding as PrelaunchBinding; return content; }
export function capturePrelaunchBinding(scenario: ScenarioRecord, run: ProvisionedRun, routes: Record<string, unknown>, outer: ModelIdentity & { thinking: string }): PrelaunchBinding {
	const rendered = artifactPrompt(scenario, run); const normalized = normalizeRenderedPrompt(rendered, run);
	const body: Omit<PrelaunchBinding, "sealHash"> = {
		phase: scenario.role, renderedPromptHash: hashObject(rendered), promptContractHash: hashObject({ normalized, task: normalizeDynamic(scenario.task), invariants: scenario.invariants.map(normalizeDynamic), exclusions: scenario.exclusions.map(normalizeDynamic), mutation: scenario.mutation, artifact: scenario.artifact, fixture: scenario.fixture, scorers: scenario.scorers }),
		expectedToolsHash: hashObject(scenario.launch.tools), fixtureHash: scenario.fixture.sha256, scorerHash: hashObject(scenario.scorers), routesHash: hashObject(routes),
		outerRequested: { provider: outer.provider, model: outer.model, version: outer.version, family: outer.family, thinking: outer.thinking, context: "fresh" },
	};
	return { ...body, sealHash: hashObject(sealContent(body)) };
}
function readSessionEvents(file: string | undefined): any[] {
	if (!file || !fs.existsSync(file)) throw new Error("authoritative outer session is unavailable");
	return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function observeOuter(result: NormalizedResult): ObservedExecutionBinding["outer"] {
	const events = readSessionEvents(result.outer.sessionFile); const model = events.find((entry) => entry.type === "model_change"); const thinking = events.find((entry) => entry.type === "thinking_level_change");
	if (!model?.provider || !model?.modelId || !thinking?.thinkingLevel) throw new Error("outer model/thinking events are unobservable");
	return { provider: String(model.provider), model: String(model.modelId), version: observedVersion(String(model.modelId)), family: observedFamily(String(model.modelId)), thinking: String(thinking.thinkingLevel), context: "fresh" };
}
export function bindObservedExecution(prelaunch: PrelaunchBinding, result: NormalizedResult): ObservedExecutionBinding {
	if (prelaunch.sealHash !== hashObject(sealContent(prelaunch))) throw new Error("prelaunch binding seal mismatch");
	if (!result.child) throw new Error("authoritative child runtime metadata is unavailable");
	return {
		...prelaunch,
		child: { agent: result.child.agent, provider: result.child.provider, model: exactModelId(result.child.model), version: observedVersion(result.child.model), family: observedFamily(result.child.model), thinking: result.child.thinking, context: result.child.context, tools: [...result.child.tools], toolsHash: hashObject(result.child.tools) },
		outer: observeOuter(result),
	};
}
export function assertObservedBinding(binding: ObservedExecutionBinding, row: ManifestRow, expected: { outer: ModelIdentity & { thinking: string }; routes: Record<string, unknown> }): void {
	const { child, outer, ...prelaunch } = binding;
	if (prelaunch.sealHash !== hashObject(sealContent(prelaunch))) throw new Error("prelaunch binding seal mismatch");
	const candidate = row.candidate;
	if (canonicalJson({ provider: child.provider, model: child.model, version: child.version, family: child.family, thinking: child.thinking, context: child.context }) !== canonicalJson({ provider: candidate.provider, model: candidate.model, version: candidate.version, family: candidate.family, thinking: candidate.thinking, context: candidate.context })) throw new Error("participant observed binding mismatch");
	if (child.toolsHash !== prelaunch.expectedToolsHash) throw new Error("tools observed binding mismatch");
	if (prelaunch.fixtureHash.trim() === "" || prelaunch.scorerHash.trim() === "" || prelaunch.promptContractHash.trim() === "" || prelaunch.renderedPromptHash.trim() === "") throw new Error("launch asset binding is unavailable");
	if (prelaunch.routesHash !== hashObject(expected.routes)) throw new Error("route observed binding mismatch");
	const expectedOuter = { provider: expected.outer.provider, model: expected.outer.model, version: expected.outer.version, family: expected.outer.family, thinking: expected.outer.thinking, context: "fresh" };
	if (canonicalJson(outer) !== canonicalJson(expectedOuter) || canonicalJson(prelaunch.outerRequested) !== canonicalJson(expectedOuter)) throw new Error("outer observed binding mismatch");
}
