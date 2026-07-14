import { DELIVERY_PHASES } from "../../shared/delivery-profile-config.ts";

export type RunnablePhase = (typeof DELIVERY_PHASES)[number];
export type Verdict = "PASS" | "PASS_WITH_NON_BLOCKING_NOTES" | "FAIL" | "INCONCLUSIVE" | "DONE" | "MR_CREATED";

export interface PhaseContract {
	artifactStem: string;
	requiredHeadings: readonly string[];
	allowedVerdicts: readonly Verdict[];
	parallelEligible: boolean;
	/** Higher values are more conservative. Present only for parallel-eligible phases. */
	aggregateVerdictPrecedence?: Readonly<Partial<Record<Verdict, number>>>;
}

/** Stable artifact and reporting contract consumed by launch, rendering, and report validation. */
export const PHASE_CONTRACTS: Record<RunnablePhase, PhaseContract> = {
	IMPLEMENT: {
		artifactStem: "01-implementation",
		requiredHeadings: ["Summary", "Required checklist", "Changed files", "Tests added or updated", "Commands run", "Evidence", "Residual risks", "Recommendation"],
		allowedVerdicts: ["PASS", "FAIL"],
		parallelEligible: false,
	},
	VERIFY: {
		artifactStem: "02-verification",
		requiredHeadings: ["Summary", "Findings", "Commands run", "Behavioral evidence", "Candidate completeness", "Residual risks", "Recommendation"],
		allowedVerdicts: ["PASS", "FAIL", "INCONCLUSIVE"],
		parallelEligible: true,
		aggregateVerdictPrecedence: { PASS: 0, INCONCLUSIVE: 1, FAIL: 2 },
	},
	REVIEW: {
		artifactStem: "03-review",
		requiredHeadings: ["Summary", "Must-fix findings", "Non-blocking notes", "Evidence reviewed", "Risk checks", "Recommendation"],
		allowedVerdicts: ["PASS", "PASS_WITH_NON_BLOCKING_NOTES", "FAIL"],
		parallelEligible: true,
		aggregateVerdictPrecedence: { PASS: 0, PASS_WITH_NON_BLOCKING_NOTES: 1, FAIL: 2 },
	},
	CLOSE: {
		artifactStem: "04-close",
		requiredHeadings: ["Summary", "Close-readiness checklist", "Branch / commit / PR", "Commands run", "Remote CI", "Residual risks"],
		allowedVerdicts: ["MR_CREATED", "DONE", "FAIL"],
		parallelEligible: false,
	},
	RETRO: {
		artifactStem: "05-retro",
		requiredHeadings: ["Outcome", "Improvement candidates", "Plan-quality lessons", "Critical fixes", "Residual risks", "Recommendations"],
		allowedVerdicts: ["DONE"],
		parallelEligible: false,
	},
};

export function phaseArtifactFilename(phase: RunnablePhase, attempt = 1): string {
	const stem = PHASE_CONTRACTS[phase].artifactStem;
	return attempt > 1 ? `${stem}-${attempt}.md` : `${stem}.md`;
}

export function phaseArtifactContractMarkdown(phase: RunnablePhase): string {
	const contract = PHASE_CONTRACTS[phase];
	return `Artifact contract for ${phase} (use these headings in this order):\n\n    RESULT: ${contract.allowedVerdicts.join("|")}\n\n${contract.requiredHeadings.map((heading) => `    ## ${heading}`).join("\n")}`;
}

/** Render the structural portion of an artifact from the same contract validators enforce. */
export function renderPhaseArtifactMarkdown(
	phase: RunnablePhase,
	verdict: Verdict,
	sectionContents: Readonly<Partial<Record<string, string>>>,
): string {
	const contract = PHASE_CONTRACTS[phase];
	if (!contract.allowedVerdicts.includes(verdict)) {
		throw new Error(`Verdict ${verdict} is not valid for ${phase}`);
	}
	const sections = contract.requiredHeadings
		.map((heading) => `## ${heading}\n${sectionContents[heading] ?? "none"}`)
		.join("\n\n");
	return `RESULT: ${verdict}\n\n${sections}\n`;
}
