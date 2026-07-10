# Delivery State Machine Compatibility Baseline

This inventory records the public and persisted behavior that the improvement plan must preserve during its initial correctness work. It describes the implementation at commit `f77f52d` on `main`.

## Baseline validation

- Dedicated worktree: `/Users/jason/ai/pi-productive-extensions-stage-0`
- Branch: `delivery/stage-0`, created from `origin/main` after `git fetch origin main`
- Baseline commit: `f77f52d` (`Allow cleanup of untracked-only worktrees (#26)`)
- Command: `npm run verify`
- Result: PASS. The delivery-state-machine, session-usage, git-cleanup, and report-viewer suites all passed.
- Tracked baseline: clean before Stage 0 documentation was added. The worktree now contains this inventory and `IMPROVEMENT_PLAN.md` as the Stage 0 candidate; `.pi-subagents/` is delivery-run metadata and is not a project deliverable.

Stage 1 must not begin from a worktree with unrelated tracked or untracked changes.

## Registered names

Commands:

- `/deliver`
- `/delivery-status`
- `/delivery-summary`
- `/delivery-reset`

Tools:

- `delivery_start`
- `delivery_next`
- `delivery_report`
- `delivery_decide`
- `delivery_status`
- `delivery_summary`
- `delivery_reset`

These names are compatibility-sensitive. Later stages may change validation and internals, but must not rename or remove them.

## Tool parameter schemas

All parameter objects use the following TypeBox shapes as currently registered.

### `delivery_start`

- `task`: required string
- `maxRepairRounds`: optional number; legacy all-phase round override
- `maxRounds`: optional object with optional numeric `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO` values

### `delivery_next`, `delivery_status`, `delivery_summary`, and `delivery_reset`

- Empty object

### `delivery_decide`

- `decision`: required enum `repair | stop | accept_risk | continue | defer`
- `rationale`: optional string

### `delivery_report`

- `phase`: required enum `IMPLEMENT | VERIFY | REVIEW | CLOSE | RETRO`
- `verdict`: optional enum `PASS | PASS_WITH_NON_BLOCKING_NOTES | FAIL | INCONCLUSIVE | DONE | MR_CREATED`
- `summary`: required string
- `artifact`: optional string
- `usageDelta`: optional usage object
- `usageAttribution`: optional enum `exact | subagent-reported | best-effort | phase-aggregate | unavailable`
- `usageSource`: optional enum `subagent | parent-session-delta | backfill | manual`
- `subagentRunId`: optional string
- `subagentSessionFile`: optional string
- `stepUsage`: optional array of child-usage objects
- `recommendedDecision`: optional enum `repair | stop | accept_risk | continue | defer`

A usage object has optional numeric `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`, `assistantMessages`, and `sessionFiles` fields. Each `stepUsage` item may identify a step with optional `stepId`, `childIndex`, or `artifact`, and accepts the same usage metadata fields as the parent report.

## Tool-result `details` shapes

### `details.state`

State-bearing tools return a JSON-cloned state with these stable fields:

- `active`, `phase`, `verifyRound`, `reviewRound`, `maxRepairRounds`, `maxPhaseRounds`, `readyToClose`, `acceptedRisks`, `history`, `steps`, and `updatedAt`
- optional `task`, `artifactDir`, `usageAtStart`, `cwd`, `gitBranch`, `gitRoot`, `lastVerificationVerdict`, `lastReviewVerdict`, `pendingIssue`, `phaseLaunches`, `launchProfile`, and `project`

`maxPhaseRounds` has `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO` numeric members. Existing state, history, step, pending-issue, project, profile, and usage field names remain compatibility-sensitive.

### `details.next`

For a runnable phase, `next` contains:

- `phase`
- primary `agent`, with optional `model`, `thinking`, and `context`
- `acceptance: false`
- `prompt` and `childPrompt` with the same child-facing content
- `orchestratorInstruction`
- `reportInstruction`
- optional `parallel`

A parallel child contains `agent`, optional `model`/`thinking`/`context`, `acceptance: false`, `childPrompt`, and, when an artifact directory exists, equal `artifact` and `output` paths plus `outputMode: "file-only"`.

The Stage 0 single-child shape does **not** expose top-level `artifact`, `output`, or `outputMode`; adding those fields later is additive. For `IDLE`, `WAITING_DECISION`, `DONE`, and `STOPPED`, `next` retains `phase`, `prompt`, `childPrompt`, and `orchestratorInstruction` using the fallback instruction.

`delivery_start`, `delivery_next`, `delivery_report`, `delivery_decide`, and `delivery_status` normally return `{ state, next }`. An inactive `delivery_report` returns only `{ state }`. `delivery_summary` returns `{ state, usage }`, and `delivery_reset` returns `{ state }`.

## Planned steps and artifact filenames

Planned step IDs use:

```text
<PHASE>-<attempt>-<childIndex-or-0>
```

Single-child steps therefore use IDs such as `IMPLEMENT-1-0`. Parallel child indexes are zero-based, for example `REVIEW-1-0` and `REVIEW-1-1`. A parallel aggregate uses `<PHASE>-<attempt>-aggregate`. Legacy history-derived report rows use `legacy-<PHASE>-<attempt>`.

Generic artifact stems are fixed:

| Phase | First attempt | Later attempt example |
|---|---|---|
| IMPLEMENT | `01-implementation.md` | `01-implementation-2.md` |
| VERIFY | `02-verification.md` | `02-verification-2.md` |
| REVIEW | `03-review.md` | `03-review-2.md` |
| CLOSE | `04-close.md` | `04-close-2.md` |
| RETRO | `05-retro.md` | `05-retro-2.md` |

Parallel child filenames use:

```text
<phase-stem>-<attempt>-<two-digit-child-number>-<launch-slug>.md
```

The launch slug is derived, in order, from agent, model, thinking, and context. Examples from the built-in REVIEW profile are `03-review-1-01-reviewer.md` and `03-review-1-02-reviewer-openai-gpt-5-5.md`.

The generated summary filenames are `00-delivery-summary.md` and `delivery-report.json`.

## Persisted session restoration

- State snapshots are appended with custom entry type `delivery-state-machine`.
- Restoration scans the active session branch in order.
- A custom entry with `type: "custom"` and `customType: "delivery-state-machine"` restores its `data`.
- A tool-result message whose `toolName` starts with `delivery_` restores `message.details.state` when present.
- Later matching entries win.
- Normalization supplies absent `acceptedRisks`, `history`, and `steps` as empty arrays.
- Legacy state without `maxPhaseRounds` maps `maxRepairRounds` to every runnable phase; otherwise missing per-phase limits use current defaults.
- Optional profile, project, and usage fields may remain absent.
- For reporting, history-only `report` events are synthesized into legacy journey steps, and explicit persisted steps take precedence for the same phase and attempt.

This permissive restoration is required for sessions written before `steps`, per-phase rounds, profiles, projects, or usage attribution existed.

## Structured report JSON v2

`delivery-report.json` remains `schemaVersion: 2` with `source: "delivery-state-machine"`. Its stable top-level contract is:

- identity and status: `id`, `task`, `status`, `phase`
- paths and repository context: `artifactDir`, optional `cwd`, `gitBranch`, `gitRoot`, `project`, and `launchProfile`
- timestamps: optional `createdAt`, plus `updatedAt` and `generatedAt`
- `summaryMarkdownPath`
- `history`, `steps`, `acceptedRisks`, and nullable `pendingIssue`
- `usage` with nullable `currentSessionTotals` and `sinceDeliveryStart`, optional/nullable `deliveryTotal`, `phaseStepsTotal`, and `parentOverhead`, plus `attribution`

Readers must prefer JSON when present, fall back to the Markdown report for legacy runs, ignore unknown additive fields, and degrade safely when optional metadata is missing. Breaking changes require a new schema version and reader fallback support. The normative field documentation remains in `docs/delivery-report-schema-v2.md` and the shared TypeScript contract remains in `shared/delivery-report.ts`.

## Markdown summary structure

`00-delivery-summary.md` keeps this order:

1. `# Delivery summary`
2. task, status, artifact directory, cwd, branch, overall usage totals, and usage-attribution note
3. `## Journey` table
4. `## Failure overview` table
5. `## Critical fixes for future plans / delivery`
6. `## Usage`
7. `## Phase counts`

The journey table columns remain `#`, `Phase`, `Agent`, `Model`, `Verdict`, `Token usage`, and `Detail`. The failure table columns remain `Failed step`, `Why it failed`, `Repair action`, and `Detail`. Legacy history-only runs must continue to render in this structure.

## Pinned launch-profile behavior

- Profile definitions come from the user-global `extensions/delivery-state-machine/phase-launches.json` when present, otherwise the bundled `phase-launches.json`.
- Project-local launch-profile overrides are ignored.
- Profile selection honors `PI_DELIVERY_PROFILE`, then saved global active-profile/default behavior as defined by the shared profile selector.
- `/deliver` and `delivery_start` resolve the profile once, then persist both `phaseLaunches` and `launchProfile` in state.
- Every later phase uses the persisted `phaseLaunches`; changing the active profile during a delivery does not change that run.
- `launchProfile` preserves `selectedProfile`, selection `source`, `definitionSource` (`global-phase-launches` or `built-in-phase-launches`), and `envOverride`.
- User-global phase prompt overrides remain supported independently of the pinned launch definitions; project-local prompt overrides are ignored.

The bundled default profile currently launches one IMPLEMENT worker, one fresh-context `fresh-verifier`, two REVIEW reviewers, one CLOSE delegate, and one RETRO delegate. Later work must preserve profile pinning and persisted profile metadata even if internal config loading is refactored.
