import type { DeliveryProfileDefinitionSource, DeliveryProfileSelectionSource } from "./delivery-profile-config.ts";
import type { UsageTotals } from "./session-usage.ts";

export type DeliveryReportPhase = "IDLE" | "IMPLEMENT" | "VERIFY" | "REVIEW" | "CLOSE" | "RETRO" | "DONE" | "STOPPED" | "WAITING_DECISION";
export type DeliveryReportRunnablePhase = "IMPLEMENT" | "VERIFY" | "REVIEW" | "CLOSE" | "RETRO";
export type DeliveryReportVerdict = "PASS" | "PASS_WITH_NON_BLOCKING_NOTES" | "FAIL" | "INCONCLUSIVE" | "DONE" | "MR_CREATED";
export type DeliveryReportDecision = "repair" | "stop" | "accept_risk" | "continue" | "defer";
export type DeliveryReportIssueSource = "implement" | "verify" | "review" | "close";
export type DeliveryReportUsageAttribution = "exact" | "subagent-reported" | "best-effort" | "phase-aggregate" | "parent-overhead" | "unavailable";

export interface DeliveryProjectMetadataV1 {
	schemaVersion: 1;
	projectId: string;
	name: string;
	root: string;
	gitRoot?: string;
	gitRemote?: string;
	createdAt: string;
	lastSeenAt: string;
}

export interface DeliveryReportHistoryEntry {
	timestamp: number;
	phase: DeliveryReportPhase;
	event: string;
	verdict?: DeliveryReportVerdict;
	decision?: DeliveryReportDecision;
	summary?: string;
	artifact?: string;
}

export interface DeliveryReportPendingIssue {
	source: DeliveryReportIssueSource;
	phase: DeliveryReportPhase;
	verdict: DeliveryReportVerdict;
	summary: string;
	artifact?: string;
	recommendedDecision?: DeliveryReportDecision;
}

export interface DeliveryReportLaunchProfile {
	selectedProfile: string;
	source: DeliveryProfileSelectionSource;
	definitionSource: DeliveryProfileDefinitionSource;
	envOverride: boolean;
}

export interface DeliveryReportStep {
	id: string;
	phase: DeliveryReportRunnablePhase;
	attempt: number;
	childIndex?: number;
	childCount?: number;
	agent?: string;
	model?: string;
	thinking?: string;
	context?: string;
	status: "planned" | "reported";
	verdict?: DeliveryReportVerdict;
	summary?: string;
	artifact?: string;
	startedAt: number;
	endedAt?: number;
	usageBefore?: UsageTotals;
	usageAfter?: UsageTotals;
	usageDelta?: UsageTotals;
	usageAttribution?: DeliveryReportUsageAttribution;
	usageSource?: "subagent" | "parent-session-delta" | "backfill" | "manual";
	subagentRunId?: string;
	subagentSessionFile?: string;
	usageBackfillBlockedAfter?: UsageTotals;
}

export interface DeliveryReportJsonV2 {
	schemaVersion: 2;
	source: "delivery-state-machine";
	id: string;
	task: string | null;
	status: DeliveryReportPhase;
	phase: DeliveryReportPhase;
	artifactDir: string;
	cwd?: string;
	gitBranch?: string;
	gitRoot?: string;
	project?: DeliveryProjectMetadataV1;
	launchProfile?: DeliveryReportLaunchProfile;
	createdAt?: number;
	updatedAt: number;
	generatedAt: number;
	summaryMarkdownPath: string;
	history: DeliveryReportHistoryEntry[];
	steps: DeliveryReportStep[];
	acceptedRisks: string[];
	pendingIssue: DeliveryReportPendingIssue | null;
	usage: {
		currentSessionTotals: UsageTotals | null;
		sinceDeliveryStart: UsageTotals | null;
		deliveryTotal?: UsageTotals | null;
		phaseStepsTotal?: UsageTotals | null;
		parentOverhead?: UsageTotals | null;
		attribution: DeliveryReportUsageAttribution;
	};
}
