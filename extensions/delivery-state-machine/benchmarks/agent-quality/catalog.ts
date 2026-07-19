import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateScenario, type ScenarioRecord } from "./schema.ts";

export const FRAMEWORK_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_ROOT = path.join(FRAMEWORK_ROOT, "scenarios");
export const FIXTURES_ROOT = path.join(FRAMEWORK_ROOT, "fixtures");

function filesRecursively(root: string, current = root): string[] {
	return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
		const target = path.join(current, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`fixture symlinks are forbidden: ${path.relative(root, target)}`);
		return entry.isDirectory() ? filesRecursively(root, target) : [target];
	}).sort();
}

export function fixtureHash(root: string): string {
	const hash = createHash("sha256");
	for (const file of filesRecursively(root)) {
		const relative = path.relative(root, file).split(path.sep).join("/");
		hash.update(`${relative}\0${(fs.statSync(file).mode & 0o777).toString(8)}\0`);
		hash.update(fs.readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function loadScenarios(options: { verifyFixtureHashes?: boolean } = {}): ScenarioRecord[] {
	const scenarios = fs.readdirSync(SCENARIOS_ROOT)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => validateScenario(JSON.parse(fs.readFileSync(path.join(SCENARIOS_ROOT, name), "utf8"))));
	const ids = new Set<string>();
	for (const scenario of scenarios) {
		if (ids.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
		ids.add(scenario.id);
		const fixture = path.resolve(FIXTURES_ROOT, scenario.fixture.path);
		if (!fixture.startsWith(`${path.resolve(FIXTURES_ROOT)}${path.sep}`) || !fs.statSync(fixture).isDirectory()) throw new Error(`fixture does not exist: ${scenario.fixture.path}`);
		if (options.verifyFixtureHashes !== false) {
			const actual = fixtureHash(fixture);
			if (actual !== scenario.fixture.sha256) throw new Error(`fixture hash mismatch for ${scenario.id}: expected ${scenario.fixture.sha256}, got ${actual}`);
		}
	}
	return scenarios;
}

export function scenarioById(id: string): ScenarioRecord {
	const scenario = loadScenarios().find((entry) => entry.id === id);
	if (!scenario) throw new Error(`unknown scenario: ${id}`);
	return scenario;
}
