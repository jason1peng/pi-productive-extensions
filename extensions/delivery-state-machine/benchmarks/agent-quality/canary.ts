import * as fs from "node:fs";
import { runScenario } from "./run.ts";
import { scenarioById } from "./catalog.ts";

const requested = process.env.DSM_AGENT_EVAL_CANARY;
if (requested !== "1") {
	console.error("Real-Pi canary is opt-in. Set DSM_AGENT_EVAL_CANARY=1 and provide model credentials.");
	process.exit(2);
}
const scenario = structuredClone(scenarioById("VER-02"));
scenario.launch.repetitions = 1;
scenario.launch.timeoutMs = Number(process.env.DSM_AGENT_EVAL_TIMEOUT_MS ?? 720_000);
const candidate = process.env.DSM_AGENT_EVAL_CANARY_CANDIDATE ?? "dsm.verifier";
const result = await runScenario({ scenario, candidate, comparisonMode: "canary", repetition: 0, retain: true });
const required = [
	result.status === "PASS",
	result.child?.agent === candidate,
	result.child?.model === scenario.launch.model,
	result.child?.thinking === scenario.launch.thinking,
	result.child?.context === scenario.launch.context,
	JSON.stringify(result.child?.tools) === JSON.stringify(scenario.launch.tools),
	Boolean(result.child?.sessionFile && fs.existsSync(result.child.sessionFile)),
	Boolean(result.child?.metadataFile && fs.existsSync(result.child.metadataFile)),
	Boolean(result.artifactPath && fs.existsSync(result.artifactPath)),
	result.redactionPassed,
];
console.log(JSON.stringify(result, null, 2));
if (required.some((value) => !value)) {
	console.error(`Canary infrastructure or evidence failure: ${result.diagnostics.join("; ") || "required evidence missing"}`);
	process.exit(1);
}
