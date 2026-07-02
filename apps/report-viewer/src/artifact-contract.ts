export type ArtifactPhase = "IMPLEMENT" | "VERIFY" | "REVIEW" | "CLOSE" | "RETRO" | "UNKNOWN";

export type ArtifactResult =
	| "PASS"
	| "PASS_WITH_NON_BLOCKING_NOTES"
	| "FAIL"
	| "INCONCLUSIVE"
	| "DONE"
	| "MR_CREATED";

export interface ParsedCommand {
	command: string;
	result?: string;
	summary?: string;
}

export interface RetroCandidate {
	title: string;
	severity: "low" | "medium" | "high";
	sourceEvidence: string;
	suggestedAction: string;
	sourceText: string;
}

export interface ParsedArtifact {
	phase: ArtifactPhase;
	result?: ArtifactResult;
	isContract: boolean;
	parseNote?: string;
	summary?: string;
	sections: Array<{ heading: string; body: string }>;
	sectionMap: Record<string, string>;
	changedFiles: string[];
	commands: ParsedCommand[];
	findings: string[];
	residualRisks: string[];
	recommendation?: string;
	retroCandidates: RetroCandidate[];
}

const allowedResults = new Set<ArtifactResult>([
	"PASS",
	"PASS_WITH_NON_BLOCKING_NOTES",
	"FAIL",
	"INCONCLUSIVE",
	"DONE",
	"MR_CREATED",
]);

const phaseByArtifactName: Array<[RegExp, ArtifactPhase]> = [
	[/implementation/i, "IMPLEMENT"],
	[/verification/i, "VERIFY"],
	[/review/i, "REVIEW"],
	[/close/i, "CLOSE"],
	[/retro/i, "RETRO"],
];

export const phaseContractHeadings: Record<Exclude<ArtifactPhase, "UNKNOWN">, string[]> = {
	IMPLEMENT: ["Summary", "Required checklist", "Changed files", "Tests added or updated", "Commands run", "Evidence", "Residual risks", "Recommendation"],
	VERIFY: ["Summary", "Findings", "Commands run", "Behavioral evidence", "Candidate completeness", "Residual risks", "Recommendation"],
	REVIEW: ["Summary", "Must-fix findings", "Non-blocking notes", "Evidence reviewed", "Risk checks", "Recommendation"],
	CLOSE: ["Summary", "Close-readiness checklist", "Branch / commit / PR", "Commands run", "Remote CI", "Residual risks"],
	RETRO: ["Outcome", "Improvement candidates", "Plan-quality lessons", "Critical fixes", "Residual risks", "Recommendations"],
};

function normalizeHeading(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function stripMarkdownLink(value: string): string {
	return value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

function stripListMarker(line: string): string {
	return line.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "").trim();
}

function parseBullets(body: string): string[] {
	return body
		.split(/\r?\n/)
		.map((line) => stripListMarker(line))
		.filter((line) => line.length > 0 && line.toLowerCase() !== "none");
}

function firstParagraph(body: string): string | undefined {
	const paragraph = body.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean);
	if (!paragraph || paragraph.toLowerCase() === "none") return undefined;
	return paragraph.replace(/\s+/g, " ");
}

function fenceMarker(line: string): string | undefined {
	const match = /^\s*(```+|~~~+)/.exec(line);
	return match?.[1][0];
}

function splitSections(markdown: string): Array<{ heading: string; body: string }> {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const sections: Array<{ heading: string; bodyLines: string[] }> = [];
	let current: { heading: string; bodyLines: string[] } | undefined;
	let activeFence: string | undefined;
	for (const line of lines) {
		const marker = fenceMarker(line);
		if (marker) activeFence = activeFence === marker ? undefined : activeFence ?? marker;
		const match = activeFence ? undefined : /^##\s+(.+?)\s*$/.exec(line);
		if (match) {
			current = { heading: match[1].trim(), bodyLines: [] };
			sections.push(current);
		} else if (current) {
			current.bodyLines.push(line);
		}
	}
	return sections.map((section) => ({ heading: section.heading, body: section.bodyLines.join("\n").trim() }));
}

const legacyHeadingAliases: Array<{ heading: string; patterns: RegExp[] }> = [
	{ heading: "Summary", patterns: [/summary/i, /outcome/i] },
	{ heading: "Required checklist", patterns: [/required checklist/i, /checklist/i] },
	{ heading: "Changed files", patterns: [/changed files?/i] },
	{ heading: "Tests added or updated", patterns: [/tests? added or updated/i] },
	{ heading: "Findings", patterns: [/findings?/i, /blockers?/i, /must-fix findings?/i, /must-fix blockers?/i] },
	{ heading: "Evidence", patterns: [/evidence/i, /behavioral evidence/i, /evidence reviewed/i, /validation output/i] },
	{ heading: "Commands run", patterns: [/commands? run/i, /validation commands?/i, /focused tests? passed/i, /fast local gate run/i] },
	{ heading: "Residual risks", patterns: [/residual risks?/i, /open risks?\/questions?/i] },
	{ heading: "Recommendation", patterns: [/recommendations?/i, /recommended next steps?/i] },
	{ heading: "Improvement candidates", patterns: [/improvement candidates?/i] },
	{ heading: "Plan-quality lessons", patterns: [/plan-quality lessons?/i, /plan quality lessons?/i] },
	{ heading: "Critical fixes", patterns: [/critical fixes?/i] },
	{ heading: "Non-blocking notes", patterns: [/non-blocking notes?/i] },
	{ heading: "Risk checks", patterns: [/risk checks?/i] },
	{ heading: "Candidate completeness", patterns: [/candidate completeness/i] },
	{ heading: "Branch / commit / PR", patterns: [/branch\s*\/\s*commit\s*\/\s*pr/i, /branch.*commit.*pr/i] },
	{ heading: "Remote CI", patterns: [/remote ci/i] },
];

function normalizeLegacyLabel(value: string): string {
	return value.replace(/^#+\s*/, "").replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
}

function legacyHeadingFor(label: string): string | undefined {
	const normalized = normalizeLegacyLabel(label);
	return legacyHeadingAliases.find((alias) => alias.patterns.some((pattern) => pattern.test(normalized)))?.heading;
}

function splitLegacySections(markdown: string): Array<{ heading: string; body: string }> {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const sections: Array<{ heading: string; bodyLines: string[] }> = [];
	let current: { heading: string; bodyLines: string[] } | undefined;
	let activeFence: string | undefined;
	const preamble: string[] = [];
	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const marker = fenceMarker(line);
		if (marker) activeFence = activeFence === marker ? undefined : activeFence ?? marker;
		const headingLine = activeFence ? undefined : /^#{1,6}\s+(.+?)\s*$/.exec(line);
		const labelLine = activeFence ? undefined : /^\s*(?:[-*+]\s*)?(?:\*\*)?([A-Za-z][A-Za-z0-9 /?_-]{2,60})(?:\*\*)?\s*:\s*(.*)$/.exec(line);
		const legacyHeading = headingLine ? legacyHeadingFor(headingLine[1]) : labelLine ? legacyHeadingFor(labelLine[1]) : undefined;
		if (legacyHeading) {
			current = { heading: legacyHeading, bodyLines: [] };
			sections.push(current);
			if (labelLine?.[2]?.trim()) current.bodyLines.push(labelLine[2].trim());
			continue;
		}
		if (current) {
			current.bodyLines.push(line);
		} else if (line.trim()) {
			preamble.push(line.trim());
		}
	}
	const mapped = sections.map((section) => ({ heading: section.heading, body: section.bodyLines.join("\n").trim() })).filter((section) => section.body.length > 0 || section.heading.length > 0);
	if (!mapped.some((section) => normalizeHeading(section.heading) === "summary")) {
		const summary = preamble.map((line) => line.replace(/^(PASS_WITH_NON_BLOCKING_NOTES|PASS|FAIL|INCONCLUSIVE|DONE|MR_CREATED)\b\s*:?(.*)$/i, "$2").trim()).find(Boolean);
		if (summary) mapped.unshift({ heading: "Summary", body: summary });
	}
	return mapped;
}

function inferPhase(options?: { phase?: ArtifactPhase; artifactPath?: string }): ArtifactPhase {
	if (options?.phase) return options.phase;
	const artifactPath = options?.artifactPath ?? "";
	for (const [pattern, phase] of phaseByArtifactName) {
		if (pattern.test(artifactPath)) return phase;
	}
	const conventionalMatch = /0[1-5]-/.exec(artifactPath);
	if (conventionalMatch) {
		if (artifactPath.includes("01-")) return "IMPLEMENT";
		if (artifactPath.includes("02-")) return "VERIFY";
		if (artifactPath.includes("03-")) return "REVIEW";
		if (artifactPath.includes("04-")) return "CLOSE";
		if (artifactPath.includes("05-")) return "RETRO";
	}
	return "UNKNOWN";
}

function parseResult(markdown: string): { result?: ArtifactResult; isContract: boolean } {
	const firstNonEmpty = markdown.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
	const contract = /^RESULT:\s*([A-Z_]+)\s*$/.exec(firstNonEmpty);
	if (contract && allowedResults.has(contract[1] as ArtifactResult)) {
		return { result: contract[1] as ArtifactResult, isContract: true };
	}
	const legacy = /^(PASS_WITH_NON_BLOCKING_NOTES|PASS|FAIL|INCONCLUSIVE|DONE|MR_CREATED)\b/i.exec(firstNonEmpty)
		?? /\b(PASS_WITH_NON_BLOCKING_NOTES|PASS|FAIL|INCONCLUSIVE|DONE|MR_CREATED)\b/i.exec(markdown.slice(0, 500));
	if (legacy) return { result: legacy[1].toUpperCase() as ArtifactResult, isContract: false };
	return { isContract: false };
}

function parseCommands(body: string): ParsedCommand[] {
	const bullets = parseBullets(body);
	return bullets.map((line) => {
		const commandMatch = /^(?:`([^`]+)`|([^:]+?))(?:\s*[-:—]\s*(pass|passed|fail|failed|not run|blocked))?(?:\s*[-:—]\s*(.*))?$/i.exec(line);
		if (!commandMatch) return { command: line };
		return {
			command: (commandMatch[1] ?? commandMatch[2] ?? line).trim(),
			result: commandMatch[3]?.trim(),
			summary: commandMatch[4]?.trim(),
		};
	});
}

function splitTableRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function parseRetroCandidates(body: string): RetroCandidate[] {
	const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const tableRows = lines.filter((line) => line.startsWith("|") && line.endsWith("|"));
	if (tableRows.length < 3) return [];
	const headers = splitTableRow(tableRows[0]).map(normalizeHeading);
	const titleIndex = headers.indexOf("title");
	const severityIndex = headers.indexOf("severity");
	const sourceIndex = headers.indexOf("source evidence");
	const actionIndex = headers.indexOf("suggested action");
	if ([titleIndex, severityIndex, sourceIndex, actionIndex].some((index) => index === -1)) return [];
	return tableRows.slice(2).map((line) => {
		const cells = splitTableRow(line);
		const severity = cells[severityIndex]?.toLowerCase();
		return {
			title: cells[titleIndex] ?? "",
			severity: severity === "high" || severity === "medium" ? severity : "low",
			sourceEvidence: stripMarkdownLink(cells[sourceIndex] ?? ""),
			suggestedAction: cells[actionIndex] ?? "",
			sourceText: line,
		};
	}).filter((candidate) => candidate.title && candidate.title.toLowerCase() !== "none");
}

export function parseArtifactContract(markdown: string, options?: { phase?: ArtifactPhase; artifactPath?: string }): ParsedArtifact {
	const phase = inferPhase(options);
	const { result, isContract } = parseResult(markdown);
	const contractSections = splitSections(markdown);
	const sections = contractSections.length ? contractSections : splitLegacySections(markdown);
	const sectionMap: Record<string, string> = {};
	for (const section of sections) sectionMap[normalizeHeading(section.heading)] = section.body;
	const get = (...names: string[]) => names.map((name) => sectionMap[normalizeHeading(name)]).find((body) => body !== undefined) ?? "";
	const summary = firstParagraph(get("Summary", "Outcome"));
	const findings = [
		...parseBullets(get("Findings")),
		...parseBullets(get("Must-fix findings")),
		...parseBullets(get("Must-fix blockers")),
	].filter((value, index, all) => all.indexOf(value) === index);
	const residualRisks = parseBullets(get("Residual risks"));
	const changedFiles = parseBullets(get("Changed files"));
	const commands = parseCommands(get("Commands run"));
	const recommendation = firstParagraph(get("Recommendation", "Recommendations"));
	const retroCandidates = phase === "RETRO" ? parseRetroCandidates(get("Improvement candidates")) : [];
	const expected = phase !== "UNKNOWN" ? phaseContractHeadings[phase] : [];
	const hasAllExpected = expected.every((heading) => sectionMap[normalizeHeading(heading)] !== undefined);
	return {
		phase,
		result,
		isContract: isContract && hasAllExpected,
		parseNote: isContract && !hasAllExpected ? "Structured parsing unavailable for this artifact: required contract headings are incomplete." : undefined,
		summary,
		sections,
		sectionMap,
		changedFiles,
		commands,
		findings,
		residualRisks,
		recommendation,
		retroCandidates,
	};
}
