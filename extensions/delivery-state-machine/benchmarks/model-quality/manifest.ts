import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBootstrapNonQualification, hashObject, validateDatasetItem, validateManifest, type DatasetItem, type ManifestRow, type Phase, type SparseManifest } from "./schema.ts";

export const MODEL_QUALITY_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BOOTSTRAP_ROOT = path.join(MODEL_QUALITY_ROOT, "bootstrap");

export interface DatasetRegistry { schemaVersion: 1; items: DatasetItem[] }
export interface BootstrapAsset { itemId: string; itemVersion: number; phase: Phase; stage7Scenarios: Array<{ id: string; path: string; sha256: string }>; handoffs: string[] }
export interface BootstrapAssets { schemaVersion: 1; source: string; assets: BootstrapAsset[] }

export function loadRegistry(file = path.join(BOOTSTRAP_ROOT, "registry.json")): DatasetRegistry {
	const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	if (value.schemaVersion !== 1 || !Array.isArray(value.items)) throw new Error("registry contract is invalid");
	const items = value.items.map(validateDatasetItem);
	const keys = new Set<string>();
	for (const item of items) {
		const key = `${item.id}@${item.version}`;
		if (keys.has(key)) throw new Error(`duplicate dataset item: ${key}`);
		keys.add(key);
	}
	return { schemaVersion: 1, items };
}

export function loadManifest(file = path.join(BOOTSTRAP_ROOT, "manifest.json")): SparseManifest {
	return validateManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function loadBootstrapAssets(registry = loadRegistry(), file = path.join(BOOTSTRAP_ROOT, "assets.json")): BootstrapAssets {
	const value = JSON.parse(fs.readFileSync(file, "utf8")) as BootstrapAssets;
	if (value.schemaVersion !== 1 || value.source !== "frozen Stage 7 agent-quality scenarios" || !Array.isArray(value.assets)) throw new Error("bootstrap asset map is invalid");
	const items = new Map(registry.items.map((item) => [`${item.id}@${item.version}`, item]));
	const seen = new Set<string>();
	for (const asset of value.assets) {
		const key = `${asset.itemId}@${asset.itemVersion}`;
		if (seen.has(key) || !items.has(key)) throw new Error(`bootstrap asset identity is missing or duplicated: ${key}`);
		seen.add(key);
		if (items.get(key)!.scope !== asset.phase || items.get(key)!.publicAssetHash !== hashObject(asset)) throw new Error(`bootstrap asset hash/scope mismatch: ${key}`);
		if (!Array.isArray(asset.stage7Scenarios) || asset.stage7Scenarios.length === 0 || asset.stage7Scenarios.some((scenario) => !/^[A-Z]{3}-\d{2}$/.test(scenario.id) || !/^scenarios\/[a-z]{3}-\d{2}\.json$/.test(scenario.path) || !/^[a-f0-9]{64}$/.test(scenario.sha256))) throw new Error(`bootstrap Stage 7 references are invalid: ${key}`);
		const expectedHandoffs = asset.phase === "E2E" ? ["IMPLEMENT->VERIFY", "VERIFY->REVIEW", "REVIEW->CLOSE", "CLOSE->RETRO"] : [];
		if (JSON.stringify(asset.handoffs) !== JSON.stringify(expectedHandoffs)) throw new Error(`bootstrap handoff map is invalid: ${key}`);
	}
	if (seen.size !== registry.items.length) throw new Error("every bootstrap registry item requires a frozen Stage 7 asset map");
	return value;
}

export function resolveRows(manifest: SparseManifest, registry: DatasetRegistry): Array<{ row: ManifestRow; item: DatasetItem }> {
	const items = new Map(registry.items.map((item) => [`${item.id}@${item.version}`, item]));
	return manifest.rows.map((row) => {
		assertBootstrapNonQualification(row, "runner");
		const item = items.get(`${row.itemId}@${row.itemVersion}`);
		if (!item) throw new Error(`manifest item is missing: ${row.itemId}@${row.itemVersion}`);
		if (item.scope !== row.phase || item.datasetClass !== row.datasetClass || item.qualificationEligible !== row.qualificationEligible) throw new Error(`manifest row does not match immutable item: ${row.slotId}`);
		if (item.lifecycle !== "active" || item.admissionState !== "admitted" || item.holdState !== "clear") throw new Error(`manifest item is not effectively admitted: ${row.slotId}`);
		return { row, item };
	});
}

export function assertExactSparseSelection(manifest: SparseManifest, requestedSlots: string[]): ManifestRow[] {
	const requested = new Set(requestedSlots);
	if (requested.size !== requestedSlots.length) throw new Error("duplicate requested slot ids are forbidden");
	const selected = manifest.rows.filter((row) => requested.has(row.slotId));
	if (selected.length !== requested.size) throw new Error("requested slots must exactly match frozen manifest rows");
	return selected;
}
