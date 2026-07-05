#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface MigrationEntry {
	sourcePath: string;
	destinationPath: string;
	projectId: string;
	action: "copy" | "move" | "skip";
	warnings: string[];
}

export interface MigrationManifest {
	schemaVersion: 1;
	generatedAt: string;
	dryRun: boolean;
	root: string;
	entries: MigrationEntry[];
}

export interface MigrationOptions {
	dryRun?: boolean;
	move?: boolean;
	force?: boolean;
	now?: Date;
}

function expandHome(value: string): string {
	return value.replace(/^~(?=$|\/)/, os.homedir()).replace(/\$\{home\}/g, os.homedir());
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function readJsonIfPresent(filePath: string): any | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isReportDirectory(dir: string): boolean {
	return fs.existsSync(path.join(dir, "delivery-report.json")) || fs.existsSync(path.join(dir, "00-delivery-summary.md"));
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "unknown-project";
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function inferProject(sourceDir: string, report: any | undefined): { metadata: Record<string, unknown>; warnings: string[] } {
	const warnings: string[] = [];
	const root = typeof report?.project?.root === "string"
		? report.project.root
		: typeof report?.gitRoot === "string"
			? report.gitRoot
			: typeof report?.cwd === "string"
				? report.cwd
				: undefined;
	const gitRoot = typeof report?.gitRoot === "string" ? report.gitRoot : root;
	const gitRemote = typeof report?.project?.gitRemote === "string" ? report.project.gitRemote : undefined;
	const rootForHash = root ? path.resolve(expandHome(root)) : sourceDir;
	const rootExists = root ? fs.existsSync(expandHome(root)) : false;
	let name = root ? path.basename(rootForHash) : "unknown-project";
	if (!root) warnings.push("Project root could not be inferred; using an unknown-project bucket.");
	else if (!rootExists) {
		warnings.push(`Inferred project root does not exist: ${root}`);
		name = `unknown-${name || "project"}`;
	}
	const projectId = `${slugify(name)}-${shortHash(rootForHash)}`;
	const timestamp = new Date().toISOString();
	return {
		metadata: {
			schemaVersion: 1,
			projectId,
			name,
			...(root ? { root: rootForHash } : {}),
			...(gitRoot ? { gitRoot: path.resolve(expandHome(gitRoot)) } : {}),
			...(gitRemote ? { gitRemote } : {}),
			createdAt: timestamp,
			lastSeenAt: timestamp,
		},
		warnings,
	};
}

function copyOrMoveDirectory(source: string, destination: string, move: boolean) {
	fs.cpSync(source, destination, { recursive: true, errorOnExist: false, force: true, verbatimSymlinks: true });
	if (move) fs.rmSync(source, { recursive: true, force: true });
}

function writeJson(filePath: string, value: unknown) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function upgradeReportJson(destinationDir: string, projectMetadata: Record<string, unknown>) {
	const reportPath = path.join(destinationDir, "delivery-report.json");
	const report = readJsonIfPresent(reportPath);
	if (!report || typeof report !== "object" || Array.isArray(report)) return;
	report.schemaVersion = 2;
	report.project = {
		projectId: projectMetadata.projectId,
		name: projectMetadata.name,
		...(projectMetadata.root ? { root: projectMetadata.root } : {}),
		...(projectMetadata.gitRoot ? { gitRoot: projectMetadata.gitRoot } : {}),
		...(projectMetadata.gitRemote ? { gitRemote: projectMetadata.gitRemote } : {}),
	};
	report.artifactDir = destinationDir;
	if (typeof report.summaryMarkdownPath === "string") report.summaryMarkdownPath = path.join(destinationDir, "00-delivery-summary.md");
	writeJson(reportPath, report);
}

export function migrateDeliveryReports(rootInput: string, options: MigrationOptions = {}): MigrationManifest {
	const dryRun = options.dryRun ?? true;
	const move = options.move ?? false;
	const force = options.force ?? false;
	const root = path.resolve(expandHome(rootInput));
	const generatedAt = (options.now ?? new Date()).toISOString();
	const entries: MigrationEntry[] = [];
	if (!isDirectory(root)) throw new Error(`Report root does not exist or is not a directory: ${root}`);
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "projects") continue;
		const sourcePath = path.join(root, entry.name);
		if (!isReportDirectory(sourcePath)) continue;
		const report = readJsonIfPresent(path.join(sourcePath, "delivery-report.json"));
		const { metadata, warnings } = inferProject(sourcePath, report);
		const projectId = String(metadata.projectId);
		const destinationPath = path.join(root, "projects", projectId, "runs", entry.name);
		let action: MigrationEntry["action"] = move ? "move" : "copy";
		if (fs.existsSync(destinationPath) && !force) {
			action = "skip";
			warnings.push("Destination already exists; pass --force to overwrite.");
		}
		entries.push({ sourcePath, destinationPath, projectId, action, warnings });
		if (dryRun || action === "skip") continue;
		fs.mkdirSync(path.join(root, "projects", projectId), { recursive: true });
		writeJson(path.join(root, "projects", projectId, "project.json"), metadata);
		copyOrMoveDirectory(sourcePath, destinationPath, move);
		upgradeReportJson(destinationPath, metadata);
	}
	return { schemaVersion: 1, generatedAt, dryRun, root, entries };
}

function printUsage() {
	console.error(`Usage: bun apps/report-viewer/scripts/migrate-delivery-reports.ts [reportRoot] [--apply] [--move] [--force]\n\nDry-run is the default. Use --apply to copy legacy flat report directories into projects/<project-id>/runs/<run-id>. Use --move with --apply to remove the legacy source after copying.`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
		process.exit(0);
	}
	const rootArg = args.find((arg) => !arg.startsWith("--")) ?? "~/.pi/delivery-run";
	const dryRun = !args.includes("--apply") && !args.includes("--move");
	const manifest = migrateDeliveryReports(rootArg, {
		dryRun,
		move: args.includes("--move"),
		force: args.includes("--force"),
	});
	console.log(JSON.stringify(manifest, null, 2));
	if (!dryRun) {
		const manifestPath = path.join(manifest.root, "projects", "migration-manifest.json");
		writeJson(manifestPath, manifest);
		console.error(`Migration manifest written to ${manifestPath}`);
	}
}
