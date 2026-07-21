import * as fs from "node:fs";
import * as path from "node:path";
import { BOOTSTRAP_ROOT, MODEL_QUALITY_ROOT } from "./manifest.ts";
import { sha256 } from "./schema.ts";

export interface Stage7Sentinels { schemaVersion: 1; stage7Commit: string; files: Record<string, string> }

export function validateStage7Sentinels(): Stage7Sentinels {
	const sentinels = JSON.parse(fs.readFileSync(path.join(BOOTSTRAP_ROOT, "stage7-sentinels.json"), "utf8")) as Stage7Sentinels;
	if (sentinels.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(sentinels.stage7Commit)) throw new Error("Stage 7 sentinel contract is invalid");
	const root = path.resolve(MODEL_QUALITY_ROOT, "../agent-quality");
	for (const [relative, expected] of Object.entries(sentinels.files)) {
		if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Stage 7 sentinel path escapes its root");
		const file = path.join(root, relative);
		if (!fs.existsSync(file)) throw new Error(`frozen Stage 7 surface is missing: ${relative}`);
		const actual = sha256(fs.readFileSync(file));
		if (actual !== expected) throw new Error(`frozen Stage 7 surface changed: ${relative}`);
	}
	return sentinels;
}
