# Report Viewer UI Improvements Plan

## Goal

Make the standalone report viewer genuinely useful for reading delivery reports on desktop and mobile, with structured views for report phases and retro content instead of raw Markdown/string-heavy pages.

## Delivery scope note

This document is the implementation contract for the report-viewer UI pass, not only a docs-only deliverable. The companion source, prompt, and test changes implement the phases marked below as completed in this delivery.

## Current status

Baseline before this UI pass:

- the report viewer read `delivery-report.json` for report overview data;
- linked each phase to Markdown artifacts such as `01-implementation.md`, `02-verification.md`, `05-retro.md`;
- rendered Markdown artifacts with a lightweight safe renderer;
- still relied on raw Markdown artifacts for phase detail content.

Status after this implementation pass:

- delivery-state-machine prompts now reinforce the stable phase artifact contract;
- the viewer parses contract artifacts and legacy sections with best-effort fallback;
- artifact pages render structured phase/retro content with raw Markdown still collapsed for audit;
- the safe renderer supports basic Markdown headings, lists, code blocks, and tables;
- report detail/list pages include responsive cards, filters, failure/repair cues, and retro improvement actions.

Remaining UX gap:

- The overview is structured, but phase detail pages are still artifact-oriented.
- Retro in particular is read from `05-retro.md`, so it is not yet a first-class structured UI.

## Desired outcome

A user should be able to open a report and quickly answer:

- What happened?
- Did it pass?
- What failed and how was it repaired?
- What should I follow up on?
- What retro improvements are proposed?
- Which artifact/evidence supports each claim?

The app should still expose raw Markdown/JSON for debugging, but the default view should be structured and scannable.

## Phase 0: Stable phase artifact contract

Status: implemented in this delivery; required before relying on structured UI parsing.

### Problem

The current delivery prompts ask subagents to keep artifacts “scan-friendly,” but they do not define a strict artifact schema. As a result, artifacts vary by phase, agent, and wording. The UI can parse Markdown heuristically, but reliable rendering requires every phase to produce predictable headings/fields.

### Scope

Update delivery-state-machine phase prompts and artifact guidance so each LLM-produced phase artifact follows a stable Markdown contract. The contract should be human-readable Markdown, but structured enough for deterministic parsing.

### Global artifact contract

Every phase artifact should start with exactly one result line:

```md
RESULT: PASS
```

Allowed result values should map to delivery verdicts where possible:

```txt
PASS
PASS_WITH_NON_BLOCKING_NOTES
FAIL
INCONCLUSIVE
DONE
MR_CREATED
```

Every phase artifact should then use these headings in this order unless a section is not applicable:

```md
## Summary

## Required checklist

## Findings

## Evidence

## Commands run

## Residual risks

## Recommendation
```

Rules:

- Use `none` for empty `Findings`, `Residual risks`, or `Recommendation`.
- Use Markdown bullet lists for checklist/evidence items.
- Use fenced code blocks only for command output snippets, not for the whole artifact.
- Avoid arbitrary heading names for required sections.
- Keep the first paragraph of `## Summary` concise enough for a phase card.
- Put detailed logs or long output behind artifact links or fenced snippets.

### Phase-specific requirements

#### IMPLEMENT

Required sections:

```md
RESULT: PASS|FAIL

## Summary
## Required checklist
## Changed files
## Tests added or updated
## Commands run
## Evidence
## Residual risks
## Recommendation
```

The UI should parse changed files, commands, and residual risks from these headings.

#### VERIFY

Required sections:

```md
RESULT: PASS|FAIL|INCONCLUSIVE

## Summary
## Findings
## Commands run
## Behavioral evidence
## Candidate completeness
## Residual risks
## Recommendation
```

Verification prompts should explicitly ask for at least one real consumer path when feasible and a clear reason when not feasible.

#### REVIEW

Required sections:

```md
RESULT: PASS|PASS_WITH_NON_BLOCKING_NOTES|FAIL

## Summary
## Must-fix findings
## Non-blocking notes
## Evidence reviewed
## Risk checks
## Recommendation
```

Parallel review child artifacts and aggregate review artifacts should use the same section names so the UI can render reviewer findings consistently.

#### CLOSE

Required sections:

```md
RESULT: MR_CREATED|DONE|FAIL

## Summary
## Close-readiness checklist
## Branch / commit / PR
## Commands run
## Remote CI
## Residual risks
```

The PR URL, branch, and commit should be parseable from the `## Branch / commit / PR` section.

#### RETRO

Required sections:

```md
RESULT: DONE

## Outcome
## Improvement candidates
## Plan-quality lessons
## Critical fixes
## Residual risks
## Recommendations
```

`## Improvement candidates` should use this exact table when there are candidates:

```md
| Title | Severity | Source evidence | Suggested action |
|---|---|---|---|
| ... | low|medium|high | ... | ... |
```

If there are no candidates, write `none`.

### Implementation notes

- Update built-in phase prompt files under `extensions/delivery-state-machine/phases/*.md`.
- Update central artifact guidance in `extensions/delivery-state-machine/index.ts` so generated child prompts reinforce the contract.
- Avoid asking subagents to output duplicate JSON. Markdown contract first; TypeScript parser can derive structured UI sections from it.
- Preserve backward compatibility: UI parser must gracefully fall back for legacy artifacts that do not follow the contract.

### Verification

- Add tests that phase prompts include the required artifact contract headings.
- Add parser fixture tests for one artifact per phase using the new contract.
- Add fallback tests for legacy artifacts without `RESULT:` or required headings.

## Phase 1: Report detail dashboard cleanup

Status: implemented in this delivery.

### Scope

Improve the main report detail page so it prioritizes useful summary information and navigation.

### Required behavior

- Replace long summary strings with compact phase cards.
- Each phase card should show:
  - phase name;
  - attempt number;
  - agent;
  - verdict/status badge;
  - short summary;
  - artifact/detail link;
  - cost if available.
- Group repeated phase attempts together, especially VERIFY/REVIEW repair loops.
- Show high-level sections:
  - Overview;
  - Phase journey;
  - Failures and repairs;
  - Retro / follow-ups;
  - Artifacts;
  - Debug details.
- Collapse raw Markdown and raw JSON by default.

### Mobile expectations

- Avoid wide tables as the primary layout.
- Use cards/lists that fit narrow screens.
- Long paths should wrap or be hidden under expandable details.
- Primary actions/links should be large enough to tap.

### Verification

- Add/adjust HTTP-rendered HTML tests proving:
  - phase cards render;
  - raw Markdown/JSON are collapsed;
  - artifacts remain linked;
  - mobile-friendly classes/layout surfaces exist.

## Phase 2: Structured phase detail pages

Status: implemented in this delivery; depends on Phase 0 for reliable new artifacts, with fallback support for legacy artifacts.

### Architecture decision

Split parsing and rendering helpers out of `server.ts` before expanding structured UI support.

Suggested modules:

```txt
apps/report-viewer/src/artifact-contract.ts   # shared parser/types for phase artifacts
apps/report-viewer/src/markdown-renderer.ts   # safe Markdown rendering helpers
apps/report-viewer/src/report-renderer.ts     # HTML rendering helpers for report pages
```

The artifact contract parser should be written as a reusable module so future extension-side JSON export can use the same parser/type definitions instead of duplicating parsing rules.

### Scope

Make phase detail pages display structured content for common artifact patterns instead of only generic Markdown.

### Required behavior

For phase artifacts, parse the Phase 0 artifact contract first:

- `RESULT:` line;
- known phase-specific headings;
- checklists;
- findings;
- evidence;
- validation commands;
- residual risks;
- recommendation.

For legacy artifacts, fall back to best-effort parsing of recognizable sections such as:

- verdict/result line;
- required checklist;
- blockers/findings;
- evidence;
- validation commands;
- residual risks;
- recommendation.

Render as:

- status header;
- checklist cards;
- findings list;
- commands/evidence block;
- raw Markdown collapsed at bottom.

### Fallback behavior

If parsing fails:

- show safe rendered Markdown;
- do not crash;
- show a small note: “Structured parsing unavailable for this artifact.”

### Verification

- Add fixtures for representative implementation, verification, review, close, and retro artifacts.
- Test parsed sections render correctly.
- Test malformed/unrecognized artifact still renders safely.

## Phase 3: First-class retro view

Status: implemented in this delivery; parses Phase 0 RETRO contract before heuristic Markdown parsing.

### Scope

Make retro content useful without reading raw Markdown.

### Current problem

`delivery-report.json` links to the retro step, but retro details come from `05-retro.md`. The app currently renders that Markdown generically.

### Required behavior

Parse `05-retro.md` using the Phase 0 RETRO contract when possible:

- `RESULT: DONE`;
- `## Outcome`;
- `## Improvement candidates` table;
- `## Plan-quality lessons`;
- `## Critical fixes`;
- `## Residual risks`;
- `## Recommendations`.

For legacy retro artifacts, parse best-effort sections when possible:

- Outcome;
- Critical fixes;
- Recommendations;
- Improvement candidates;
- Plan-quality lessons;
- Evidence table;
- Residual risks.

Render a dedicated retro panel/page with:

- concise outcome card;
- list of actionable improvements;
- severity badges;
- source evidence links;
- “Create improvement” action prefilled from a recommendation;
- raw retro Markdown collapsed.

### Improvement candidate extraction

Initial implementation should be deterministic only:

- parse the `## Improvement candidates` table from the RETRO contract;
- each table row becomes a suggested app-owned improvement candidate;
- do not infer candidates from freeform recommendations automatically;
- do not use LLM extraction by default.

Clarification: “one-click improvement candidate” means the UI shows a button like “Create improvement” next to a parsed retro table row. Clicking it pre-fills/saves an item in `.report-viewer/improvements.json` using the row title, severity, source evidence, and suggested action. It should not automatically approve or run the improvement.

Automatic candidate rule for now:

- Only rows under `## Improvement candidates` become one-click candidates.
- Rows under `## Recommendations` or `## Plan-quality lessons` are displayed, but not automatically converted unless the user manually clicks “Create from this text” later.

Optional future enhancement:

- prompt-assisted extraction behind explicit user action.

### Storage

Continue storing app-owned improvement metadata under:

```txt
<artifactDir>/.report-viewer/improvements.json
```

Do not mutate extension-owned artifacts.

### Verification

- Add retro Markdown fixture with outcome, table, recommendations, and critical fixes.
- Test retro cards render.
- Test “Create improvement” prefill includes source artifact and source text.
- Test raw Markdown remains available.

## Phase 4: Better report list

Status: implemented in this delivery.

### Scope

Improve `/reports` so users can find useful reports quickly.

### Required behavior

- Show compact cards or responsive table.
- Keep the client simple for now: use server-rendered pages and query-parameter filtering rather than a client-side app.
- Add filters/search via query parameters:
  - status;
  - source: JSON vs legacy Markdown;
  - date range or recent only;
  - task text.
- Highlight reports with:
  - failed verification/review;
  - accepted risks;
  - retro improvements;
  - pending app-owned improvement runs.

### Verification

- Test reports list renders multiple statuses and sources.
- Test search/filter query parameters.
- Test legacy reports remain visible.

## Phase 5: Structured retro JSON export from extension

Status: future / optional.

### Scope

If deterministic Markdown parsing becomes too brittle, extend the delivery-state-machine extension to write app-readable retro metadata.

Possible file:

```txt
<artifactDir>/retro-report.json
```

Possible shape:

```ts
type RetroReportJsonV1 = {
  schemaVersion: 1;
  sourceArtifact: string;
  outcome?: string | null;
  criticalFixes: RetroItem[];
  recommendations: RetroItem[];
  planQualityLessons: RetroItem[];
  residualRisks: string[];
};
```

### Constraint

Do not ask LLMs to produce duplicate long JSON if it increases output tokens. Prefer TypeScript extraction from the retro artifact or concise structured retro prompts only if justified.

## Recommended implementation order

1. Update delivery-state-machine phase prompts and central artifact guidance with the Phase 0 artifact contract.
2. Add shared artifact contract parser/types and representative fixtures for IMPLEMENT, VERIFY, REVIEW, CLOSE, and RETRO.
3. Split Markdown rendering and report rendering helpers out of `server.ts`.
4. Render structured phase detail pages from parsed artifact sections, with raw Markdown fallback.
5. Render first-class retro page/cards from the RETRO contract.
6. Add one-click “Create improvement” buttons for rows in the RETRO `## Improvement candidates` table.
7. Add report list query-parameter filters/search.
8. Keep raw Markdown/JSON debug views available throughout.

## Non-goals for the next UI pass

- Full frontend framework rewrite.
- Multi-user support.
- Remote hosting/auth redesign.
- Replacing all Markdown artifacts.
- LLM-based retro extraction by default.
- Auto-approving or auto-running retro improvements.
- Generating standalone plan files for improvements by default; improvement metadata should go to `.report-viewer/improvements.json`.

## Acceptance criteria for this implementation

- Delivery-state-machine phase prompts define and reinforce a stable artifact contract for IMPLEMENT, VERIFY, REVIEW, CLOSE, and RETRO.
- New phase artifacts begin with `RESULT:` and use known headings so the UI can parse them deterministically.
- Report detail page is scannable on mobile without horizontal table-heavy reading.
- Phase detail pages provide structured sections for the new artifact contract and graceful fallback for legacy artifacts.
- Retro page shows actionable cards/recommendations from the RETRO contract, not only raw Markdown.
- Raw Markdown remains available for audit/debugging.
- Legacy/unparseable artifacts degrade gracefully.
- `npm run report-viewer:verify` passes.
- `npm run verify` passes.

## Resolved decisions

- Artifact contract parser: keep it under `apps/report-viewer/src/` initially. It should be reusable within the viewer, but do not create a repo-level shared package until the extension actually needs to import it.
- Parsing/rendering organization: split structured phase/retro parsing and Markdown/rendering helpers out of `server.ts` before the UI grows further.
- Filtering/search: keep the client simple for now; use server-rendered pages and query-parameter filtering instead of a client-side app.
- One-click retro candidates: explicit rows in the RETRO `## Improvement candidates` table should show a “Create improvement” button. Clicking it creates a proposed app-owned improvement in `.report-viewer/improvements.json`; it must not approve or run the improvement.
- Recommendations and plan-quality lessons: display them as useful context, but defer “Create from this text” buttons for the first UI pass because those sections may contain broad process advice rather than concrete code changes.

## Open questions

- None for the first UI pass.
