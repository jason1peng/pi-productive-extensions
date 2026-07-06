# Report Viewer Readability and Link Reliability Plan

## Goal

Make the report viewer easier to scan and make phase artifact/detail links reliable for the existing structured delivery reports.

This plan responds to these user issues:

1. `/reports` uses dense card grids grouped by project; a list view should be easier to read.
2. Delivery task titles are often too long for list/detail headings.
3. Report/phase summaries are often generic and do not tell the user what happened.
4. Many `Open artifact/detail` links fail, especially reports whose phase artifacts are absolute paths outside the report root or stale/multi-artifact values.
5. Detail pages use two-column grids for long phase/artifact content, making reports hard to read.

## Evidence from recon

- `apps/report-viewer/src/server.ts` renders project groups as nested auto-fit grids through `reportsHtml()`, `projectGroupHtml()`, `reportCardHtml()`, `phaseJourneyHtml()`, and `structuredSectionsHtml()`.
- `apps/report-viewer/src/report-renderer.ts` defines generic `.section-grid` and `.phase-grid` styles that create multi-column layouts for both dashboard cards and long-form detail content.
- `report.task` is rendered verbatim as the report-card link and detail `<h1>`.
- Phase cards use `step.summary` directly and only truncate; they do not prefer parsed artifact summaries from `apps/report-viewer/src/artifact-contract.ts`.
- Structured step artifact values are rendered as links without checking whether they can be opened. `resolveArtifactPath()` currently only allows local artifacts inside the report directory or configured report roots, even though `docs/delivery-report-schema-v2.md` allows absolute local artifact paths. Real reports include absolute artifacts such as `/Users/jason/work/projects/SubscriptionTracker-quality-audit/delivery/01-implementation.md`, which exist but are outside `~/.pi/delivery-run`.
- Some historical aggregate review steps store multiple artifact paths in one string separated by semicolons; the viewer treats that whole string as one path, so the link cannot resolve.

## Scope boundaries

### Must change in PR 1

- Replace report cards inside project groups with a compact grouped list/row view.
- Keep project grouping, but make project metadata compact rather than competing with reports.
- Add deterministic compact display titles for long tasks and preserve full task text in `title` attributes or expandable details.
- Add concise report briefs for each report row using structured steps and repair/failure signals without scanning many artifacts on the list page.
- On the report detail page, use a compact heading plus a collapsed full task block.
- Improve phase card summaries by preferring parsed artifact `## Summary` / `## Outcome` when the artifact resolver says the artifact can be safely read, falling back to the JSON step summary.
- Make phase artifact links honest and reliable:
  - split semicolon-separated artifact strings into separate links;
  - direct-link external URLs;
  - allow exact absolute local paths that are explicitly referenced by the structured report, while still rejecting arbitrary absolute paths, traversal, non-files, and symlink escapes;
  - mark missing/unopenable artifacts instead of rendering a broken `Open artifact/detail` link.
- Make report detail phase groups and artifact detail sections single-column reading layouts.
- Update focused route/helper tests and README behavior notes.

### Must not change in PR 1

- Do not add an LLM call or runtime AI title generation in the viewer.
- Do not introduce a frontend framework, database, auth redesign, or client-side app rewrite.
- Do not remove project grouping or existing filter query parameters.
- Do not mutate existing delivery reports or extension-owned artifacts.
- Do not weaken artifact path safety for arbitrary user-supplied local paths.
- Do not change delivery-state-machine generation behavior unless tests reveal a required compatibility fix.

### Follow-up / optional PR 2

If deterministic compact titles are not enough, consider adding a persisted `displayTitle` or generated short title to future `delivery-report.json` output from the delivery extension. That would need its own plan because it changes the report schema/producer contract and may involve LLM-generated text.

## PR 1 helper contracts

### Compact title rules

`compactTaskTitle(task, fallback)` should be deterministic and cheap:

- collapse whitespace, trim, and remove one pair of wrapping quotes/backticks;
- if empty, return the fallback report/run id or `Untitled delivery report`;
- cap the display title at about 90–100 characters on a word boundary with an ellipsis;
- never discard the full task: include it in a `title` attribute and a collapsed full-task details block on the detail page.

This is intentionally truncation/compaction, not AI title generation.

### Artifact reference splitting

`artifactReferences(value)` should be the only helper that turns `step.artifact` into renderable references:

- accept only strings; non-strings produce an empty list;
- trim whitespace and ignore empty entries;
- do not split a single external URL;
- split multi-artifact strings only on semicolon delimiters that are followed by whitespace or surrounded by whitespace, so URL path semicolons are preserved;
- trim each entry and deduplicate exact entries while preserving order.

### Artifact authorization and openability

Use one shared resolver/openability helper for report-owned local artifact access. It should be used by phase cards, artifact lists, artifact verdict/summary reads, the HTML artifact route, and the API artifact route.

Safety contract:

- Load the report JSON for the requested `viewerReportId` and build the trusted reference set by applying `artifactReferences()` to every `steps[].artifact` string.
- External URLs are openable only when their parsed URL protocol is `http:` or `https:`. They render as direct outbound links or an informational local page; the API route must not proxy them. Malformed URLs and unsafe schemes such as `javascript:`, `data:`, `file:`, and `vbscript:` are blocked/unopenable text with no `href`.
- Relative artifact paths are resolved from the report directory and must reject traversal/encoded `..`, exist, be files, and stay inside the report directory or configured report roots after realpath checks.
- Absolute artifact paths include POSIX absolutes plus Windows drive/UNC forms; classify those local path forms before unsafe URL-scheme blocking so `C:/...` is not mistaken for a `c:` URL. Absolute artifact paths are allowed only when the requested absolute path matches an absolute path explicitly present in the trusted reference set after normal path resolution. They must exist and be regular files after `lstat`/`stat`; absolute symlink references are rejected for PR 1 instead of followed. Arbitrary absolute paths not present in the structured report are rejected.
- Missing referenced files should return a missing state for UI rendering and a clear route error if requested directly.
- Semicolon-split references participate independently in authorization and rendering.

Intentional exceptions:

- `sourceEvidenceHtml()` may continue to link only safe relative Markdown filenames mentioned in text; it should not authorize new absolute paths.
- `retroCandidatesFromArtifact()` may continue to read the conventional local retro artifact only when the path is relative and safe.

### Bounded parsing

- `/reports` row briefs should be derived from `delivery-report.json` steps, verdicts, attempts, failures/repairs, accepted risks, and app-owned improvement counts. Do not parse multiple Markdown artifacts for every row.
- Report detail may parse at most the first openable local artifact for a step to improve that phase card summary.
- Artifact pages parse only the opened artifact.

## Implementation phases for PR 1

### Phase A: Tests and helper seams

Add or update tests before broad UI changes where practical.

Candidate helper seams in `apps/report-viewer/src/server.ts`:

- `compactTaskTitle(task: string, fallback?: string): string`
- `reportBrief(report: ReportSummary): string`
- `artifactReferences(value: unknown): string[]`
- `artifactLinkStatus(config, viewerReportId, artifactRef): openable | missing | external | blocked`
- `stepDisplaySummary(step, reportDir): string`

Expected tests:

- Long task title renders with a compact title and full-task disclosure.
- Report list uses row/list classes rather than nested card grids for reports.
- Phase summaries prefer artifact contract summaries over generic `step.summary` only after the artifact helper marks the artifact openable.
- Referenced absolute structured step artifacts outside the report root open through the HTTP artifact route.
- Referenced/unreferenced Windows-style absolute artifact paths are classified as local absolute artifact paths rather than unsafe URL schemes.
- Unreferenced absolute artifacts are blocked through the HTTP artifact route.
- External `http:`/`https:` URLs are direct links and are not proxied by the API artifact route.
- Unsafe external-like values such as `javascript:alert(1)`, `data:...`, and `file:///etc/passwd` render as blocked text with no `href`.
- Semicolon-separated aggregate artifact strings render as multiple artifact links.
- Missing artifacts render no broken `href` and show a clear missing/blocked state.
- Explicitly referenced absolute symlinks and unreferenced absolute symlink/target paths are rejected.
- Special-character artifact paths are covered if a small fixture can do so without obscuring the test.
- Phase detail groups and structured artifact sections expose single-column layout classes.

### Phase B: Artifact reference/openability resolver

This phase is a dependency for reliable summaries and links.

- Implement `artifactReferences()` with the explicit splitting/dedup rules above.
- Implement a shared report-owned artifact resolver/openability helper.
- Update `artifactListFromStructured()`, `phaseStepCardHtml()`, `artifactResultVerdict()`, summary reads, and the HTML/API artifact routes to use the same safety model.
- Preserve existing traversal, symlink escape, and non-file protections.
- Use a query-parameter artifact route if wildcard path routing cannot reliably encode absolute paths, semicolon-split references, or paths containing special characters; keep existing `/reports/:id/artifacts/*artifactPath` links compatible.

### Phase C: Link reliability UI

- Render one link per openable artifact reference.
- Direct-link only parsed `http:`/`https:` external references with `rel="noreferrer"`; do not route them through the API proxy.
- Render unsafe schemes, malformed URL-like values, and missing/blocked referenced artifacts as clear muted text or warning badges, not as `Open artifact/detail` anchors.
- Include enough label text to distinguish aggregate/child artifacts and multiple references.

### Phase D: Grouped list view and title readability

- Replace `reportCardHtml()` with a compact `reportRowHtml()`.
- Keep `projectGroupHtml()` sections but reduce always-visible metadata to project name, visible run count, latest timestamp, and warning badges.
- Move long project paths/remotes into a collapsed `<details>` block.
- Add a row layout with:
  - compact title link;
  - full task available via `title` and/or an inline collapsed details element;
  - project/report id secondary metadata;
  - status/source badges;
  - concise report brief derived from structured steps;
  - latest timestamp and action link.
- Update CSS so `.project-groups` and `.report-list` are vertical lists, not nested auto-fit grids.

### Phase E: Detail summaries and reading layout

- Detail page `<h1>` should use the compact title; the full task should be visible in a collapsed block near the top.
- `phaseJourneyHtml()` should render phase groups in a single column.
- `phaseStepCardHtml()` should use parsed artifact summaries first where the resolver says the artifact is openable, otherwise fall back to the JSON summary.
- `structuredSectionsHtml()` should render artifact sections in a single-column `.artifact-sections` layout.
- Keep raw Markdown and raw structured JSON collapsed for audit/debugging.

### Phase F: Docs and validation

- Update `apps/report-viewer/README.md` to describe grouped list behavior, compact titles/full-task disclosure, and exact referenced absolute artifact support.
- Note that exact structured-report absolute paths are openable, but arbitrary absolute paths are still blocked.
- Run `npm run report-viewer:verify`.
- Run `npm run verify` before close if dependency/runtime cost is acceptable; otherwise explain the narrower validation and residual risk.
- Do a quick manual or browser/narrow-width inspection if practical; otherwise record that visual inspection was not performed and rely on route/layout-class tests.

## Acceptance criteria

- `/reports` is a grouped list view, not a nested card grid.
- Long report tasks do not dominate the list or detail heading; full text remains accessible.
- Each report row gives a concise useful brief, not only a pass/fail status.
- Phase cards prefer useful artifact summaries and still show agent/verdict/cost when available.
- Known real-world absolute artifact/detail links such as worktree `delivery/*.md` files open when explicitly referenced by the report JSON.
- Missing/stale artifact or detail references are visible as missing/blocked states instead of broken links.
- Semicolon-separated artifact references render as separate links or states.
- External `http:`/`https:` artifacts are direct links and are not proxied by the API; unsafe URL schemes render as blocked text.
- Referenced absolute symlinks are rejected rather than followed.
- Detail phase groups and artifact sections read top-to-bottom in one column.
- Artifact safety tests still prove traversal, symlink escape, and arbitrary absolute path reads are rejected.
- `npm run report-viewer:verify` passes.

## Validation commands

```bash
npm run report-viewer:verify
npm run verify
```

## Open questions

- None blocking for PR 1. The requested “AI generated proper title” is intentionally deferred in favor of deterministic compact titles/truncation because runtime LLM title generation would add cost, latency, storage/schema questions, and nondeterminism.
