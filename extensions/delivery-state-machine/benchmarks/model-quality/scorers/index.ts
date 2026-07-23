import type { PhaseEvidence } from "../schema.ts";

export interface DeterministicScore { passed: boolean; criticalFailures: string[]; diagnostics: string[] }

export function scorePhaseEvidence(evidence: PhaseEvidence): DeterministicScore {
	const critical: string[] = [];
	const diagnostics: string[] = [];
	for (const [field, passed] of [["runtime identity", evidence.runtimeIdentityMatch], ["artifact", evidence.artifactValid], ["cleanup", evidence.cleanupPassed], ["behavior", evidence.behaviorPassed], ["mutation", evidence.mutationPassed], ["git", evidence.gitPassed]] as const) if (!passed) critical.push(field);
	switch (evidence.phase) {
		case "IMPLEMENT": break;
		case "VERIFY":
			if (evidence.knownOutcomeCorrect !== true) critical.push("known outcome");
			if (evidence.readOnlyPassed !== true) critical.push("read-only contract");
			break;
		case "REVIEW":
			if (evidence.knownOutcomeCorrect !== true) critical.push("known outcome");
			if (evidence.readOnlyPassed !== true) critical.push("read-only contract");
			if (evidence.falsePositive === true) critical.push("false positive");
			break;
		case "CLOSE":
			if (evidence.judgeRequested) critical.push("CLOSE judge admission");
			break;
		case "RETRO":
			if (evidence.evidenceBacked !== true) critical.push("unsupported retrospective claim");
			if (evidence.fabricationFree !== true) critical.push("fabrication");
			if (evidence.readOnlyPassed !== true) critical.push("read-only contract");
			break;
	}
	if (critical.length) diagnostics.push(`deterministic critical failure: ${critical.join(", ")}`);
	return { passed: critical.length === 0, criticalFailures: critical, diagnostics };
}

export function classifyInfrastructure(input: { launcher?: boolean; authentication?: boolean; quota?: boolean; identity?: boolean; scorer?: boolean; evidence?: boolean; cleanup?: boolean }): "scored" | "infrastructure" {
	return Object.values(input).some((failed) => failed) ? "infrastructure" : "scored";
}

export function falseRates(cases: Array<{ expectedPass: boolean; actualPass: boolean; supportedBlocker?: boolean }>): { falsePasses: number; falseFails: number; falsePositives: number } {
	return {
		falsePasses: cases.filter((entry) => !entry.expectedPass && entry.actualPass).length,
		falseFails: cases.filter((entry) => entry.expectedPass && !entry.actualPass).length,
		falsePositives: cases.filter((entry) => entry.expectedPass && entry.supportedBlocker === false).length,
	};
}
