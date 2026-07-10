# Delivery Report Schema v2

`delivery-state-machine` writes structured reports to each run directory as `delivery-report.json`. The report viewer treats this file as the preferred source of truth and falls back to `00-delivery-summary.md` for legacy runs.

## Location

Current report roots use the project layout:

```text
<artifactRoot>/projects/<project-id>/project.json
<artifactRoot>/projects/<project-id>/runs/<run-id>/delivery-report.json
<artifactRoot>/projects/<project-id>/runs/<run-id>/00-delivery-summary.md
```

`project.json` is local metadata for grouping reports. Run directories may also contain phase artifacts such as `01-implementation.md`, `02-verification.md`, and parallel review artifacts.

## `project.json`

```ts
interface DeliveryProjectMetadataV1 {
  schemaVersion: 1;
  projectId: string;
  name: string;
  root: string;
  gitRoot?: string;
  gitRemote?: string;
  createdAt: string;
  lastSeenAt: string;
}
```

The report viewer should tolerate missing or malformed project metadata by showing an inferred/unknown project group instead of failing the report list.

## `delivery-report.json`

```ts
interface DeliveryReportJsonV2 {
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
  launchProfile?: {
    selectedProfile: string;
    source: string;
    definitionSource: "global-phase-launches" | "built-in-phase-launches";
    envOverride: boolean;
  };
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
    attribution: "exact" | "subagent-reported" | "best-effort" | "phase-aggregate" | "parent-overhead" | "unavailable";
  };
}
```

Important fields:

- `schemaVersion` is `2` for the current structured report shape.
- `source` is always `delivery-state-machine`.
- `status` and `phase` reflect the current/final delivery state.
- `summaryMarkdownPath` points to the human-readable summary written beside the JSON.
- `history` preserves state-machine events for backwards compatibility and debugging.
- `steps` is the preferred phase journey for UI rendering.

## Step and artifact fields

Each `steps[]` entry represents a planned or reported child/aggregate phase:

```ts
interface DeliveryReportStep {
  id: string;
  phase: "IMPLEMENT" | "VERIFY" | "REVIEW" | "CLOSE" | "RETRO";
  attempt: number;
  childIndex?: number;
  childCount?: number;
  agent?: string;
  model?: string;
  thinking?: string;
  context?: string;
  status: "planned" | "reported";
  verdict?: "PASS" | "PASS_WITH_NON_BLOCKING_NOTES" | "FAIL" | "INCONCLUSIVE" | "DONE" | "MR_CREATED";
  summary?: string;
  artifact?: string;
  startedAt: number;
  endedAt?: number;
  usageBefore?: UsageTotals;
  usageAfter?: UsageTotals;
  usageDelta?: UsageTotals;
  usageAttribution?: "exact" | "subagent-reported" | "best-effort" | "phase-aggregate" | "parent-overhead" | "unavailable";
  usageSource?: "subagent" | "parent-session-delta" | "backfill" | "manual";
  subagentRunId?: string;
  subagentSessionFile?: string;
}
```

Artifact paths may be relative to the run directory, absolute local paths, or external URLs. Consumers must reject path traversal and symlink escapes before reading local artifacts.

## Usage totals

`UsageTotals` uses the shared session usage parser:

```ts
interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  assistantMessages: number;
  sessionFiles: number;
}
```

Token fallback policy is stable across delivery summaries and `/session-usage-all`: prefer numeric `usage.totalTokens`, then numeric `usage.total`, then `input + output + cacheRead + cacheWrite`.

`delivery_report` can receive child-native usage explicitly. For single-child phases, callers may pass `usageDelta` directly, or pass `subagentSessionFile` / `subagentRunId` and let the state machine parse matching child session usage. For parallel phases, callers pass `stepUsage[]` entries keyed by `stepId`, `childIndex`, or child `artifact`; each entry may include either `usageDelta` or a resolvable `subagentSessionFile` / `subagentRunId`. Direct `usageDelta` takes precedence over session-file/run-id resolution.

## Backwards compatibility

- Consumers should prefer `delivery-report.json` when present.
- Legacy runs with only `00-delivery-summary.md` must remain readable.
- Unknown additive fields should be ignored by readers.
- Missing optional metadata should degrade to `unknown`, `inferred`, or `unavailable` UI states instead of crashing.
- Breaking schema changes require a new `schemaVersion` and reader fallback support.
