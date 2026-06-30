import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function expandHome(value: string): string {
	return value.replace(/^~(?=$|\/)/, os.homedir()).replace(/\$\{home\}/g, os.homedir());
}

function markdownValue(markdown: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}:\\s*(.+)$`, "m").exec(markdown)?.[1]?.trim();
}

function nullableMarkdownValue(markdown: string, label: string): string | null {
	return markdownValue(markdown, label) ?? null;
}

function splitMarkdownTableRow(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim().replace(/^\[(.+?)\]\(.+?\)$/, "$1"));
}

function parseJourneySteps(markdown: string) {
	const lines = markdown.split(/\r?\n/);
	const journeyIndex = lines.findIndex((line) => /^##\s+Journey\s*$/.test(line));
	if (journeyIndex === -1) return [];
	const tableLines: string[] = [];
	for (const line of lines.slice(journeyIndex + 1)) {
		if (/^##\s+/.test(line)) break;
		if (line.trim().startsWith("|")) tableLines.push(line);
	}
	const rows = tableLines.filter((line) => !/^\|?\s*-+/.test(line.replace(/\|/g, "|"))).slice(1);
	return rows.map((row, index) => {
		const cells = splitMarkdownTableRow(row);
		const phaseCell = cells[1] ?? "";
		const phaseMatch = /^(\S+)(?:\s+#(\d+))?/.exec(phaseCell);
		return {
			id: `legacy-${index + 1}`,
			phase: phaseMatch?.[1] ?? null,
			attempt: phaseMatch?.[2] ? Number(phaseMatch[2]) : 1,
			agent: cells[2] || null,
			model: cells[3] || null,
			status: "reported",
			verdict: cells[4] || null,
			summary: cells[6] || null,
			startedAt: null,
			endedAt: null,
		};
	});
}

export function convertLegacyReport(reportDirInput: string, options: { overwrite?: boolean; now?: number } = {}) {
	const reportDir = path.resolve(expandHome(reportDirInput));
	const markdownPath = path.join(reportDir, "00-delivery-summary.md");
	const jsonPath = path.join(reportDir, "delivery-report.json");
	if (!fs.existsSync(markdownPath)) throw new Error(`Missing ${markdownPath}`);
	if (fs.existsSync(jsonPath) && !options.overwrite) throw new Error(`${jsonPath} already exists; pass --overwrite to replace it`);
	const markdown = fs.readFileSync(markdownPath, "utf8");
	const markdownStat = fs.statSync(markdownPath);
	const generatedAt = options.now ?? Date.now();
	const status = nullableMarkdownValue(markdown, "Status");
	const report = {
		schemaVersion: 1,
		source: "legacy-markdown-conversion",
		id: path.basename(reportDir),
		task: nullableMarkdownValue(markdown, "Task"),
		status,
		phase: nullableMarkdownValue(markdown, "Phase"),
		artifactDir: markdownValue(markdown, "Artifact directory") ?? reportDir,
		cwd: nullableMarkdownValue(markdown, "Cwd"),
		gitBranch: nullableMarkdownValue(markdown, "Branch"),
		gitRoot: nullableMarkdownValue(markdown, "Git root"),
		createdAt: null,
		updatedAt: markdownStat.mtimeMs,
		generatedAt,
		summaryMarkdownPath: markdownPath,
		history: [],
		steps: parseJourneySteps(markdown),
		acceptedRisks: [],
		pendingIssue: null,
		usage: {
			currentSessionTotals: null,
			sinceDeliveryStart: null,
			attribution: "unavailable",
		},
		conversion: {
			sourceMarkdownPath: markdownPath,
			note: "Best-effort deterministic conversion from legacy Markdown; unknown fields are null or empty.",
		},
	};
	const tmpPath = `${jsonPath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	fs.renameSync(tmpPath, jsonPath);
	return { jsonPath, report };
}

if ((import.meta as any).main) {
	const args = process.argv.slice(2);
	const overwrite = args.includes("--overwrite");
	const reportDir = args.find((arg) => arg !== "--overwrite");
	if (!reportDir) {
		console.error("Usage: npm run convert-report -- <artifactDir> [--overwrite]");
		process.exit(2);
	}
	try {
		const { jsonPath } = convertLegacyReport(reportDir, { overwrite });
		console.log(`Wrote ${jsonPath}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
