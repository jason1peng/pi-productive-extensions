# Report Viewer Project Grouping Plan

## Goal

Update the report viewer so the reports index presents delivery runs grouped by project from the new project-aware report layout:

```text
<artifactRoot>/projects/<project-id>/project.json
<artifactRoot>/projects/<project-id>/runs/<run-id>/delivery-report.json
```

The viewer already scans the project layout; this plan focuses on making that structure visible and useful in the UI.

## Current context

- PR #12 introduced project-scoped report directories and `project.json` metadata.
- PR #12 updated report-viewer scanning/routing to discover nested `projects/*/runs/*` reports.
- The current report list is still primarily a flat card list.
- Migrated legacy reports may have incomplete project metadata and can live under `unknown-*` project buckets.

## Scope

### Must change

- Group the `/reports` page by project.
- Show project metadata for each group when available:
  - project name;
  - project id;
  - git root/root path;
  - git remote;
  - number of runs;
  - latest run timestamp.
- Keep filters working across all projects.
- Keep report detail URLs and artifact URLs compatible with existing `viewerReportId` routing.
- Support unknown/stale project buckets gracefully.
- Preserve current profile selector panel at the top of `/reports`.

### Must not change

- Do not add project-level profile/model setup.
- Do not make the viewer write to project roots.
- Do not reintroduce permanent flat-layout scanning.
- Do not require migrated legacy reports to have complete metadata.

## UX proposal

`/reports` should render:

1. Delivery model profile panel.
2. Filters panel.
3. Project groups.

Example group:

```text
pi-productive-extensions
/Users/jason/ai/pi-productive-extensions
Remote: git@github.com:jason1peng/pi-productive-extensions.git
Runs: 8 · Latest: 2026-07-05

[report card] [report card] ...
```

Unknown project groups should be explicit:

```text
Unknown project
Project id: unknown-project-6290a923
Runs: 1
Metadata incomplete; likely migrated from a legacy flat report.
```

## Data model

Add a project grouping helper in `apps/report-viewer/src/server.ts`:

```ts
interface ProjectReportGroup {
  viewerProjectId: string;
  projectId: string;
  projectName: string;
  projectRoot?: string;
  gitRoot?: string;
  gitRemote?: string;
  runCount: number;
  latestUpdatedAt: number;
  reports: ReportSummary[];
  metadataSource: "project-json" | "report-json" | "inferred";
  warnings: string[];
}
```

Possible helper:

```ts
function groupReportsByProject(reports: ReportSummary[]): ProjectReportGroup[]
```

If `ReportSummary` does not contain enough project metadata, extend scanning to read `project.json` once per project directory and attach metadata to each summary or group.

## Routing

Keep existing report routes:

```text
/reports/:viewerReportId
/reports/:viewerReportId/artifacts/*artifactPath
```

Optional project route can be added later, but not required for the first grouping pass:

```text
/projects/:viewerProjectId
```

If added now, it should be read-only and just show the same project group filtered to one project.

## Filtering behavior

Filters should apply before grouping:

```text
all reports -> apply status/source/task/recent filters -> group filtered reports by project
```

This makes project run counts reflect the currently visible filtered result. If needed, display both:

```text
Showing 3 of 8 runs
```

but this is optional.

## Sorting behavior

- Project groups sorted by latest run timestamp descending.
- Reports inside each project sorted by updated timestamp descending.
- Unknown projects sorted normally by latest run timestamp.

## Implementation steps

### Step 1: Metadata plumbing

- Extend `ReportSummary` or add an internal grouping structure with project metadata.
- Read `project.json` for project-layout reports.
- Preserve safe behavior if `project.json` is missing, malformed, or incomplete.

Acceptance:

- Project-layout reports have project name/id/root/remote available to renderer when present.
- Missing/malformed `project.json` does not crash `/reports`.

### Step 2: Grouping renderer

- Add `groupReportsByProject()`.
- Replace the flat card list on `/reports` with grouped sections.
- Keep existing report cards inside each group.
- Keep empty-state behavior.

Acceptance:

- `/reports` shows project headings with report cards grouped underneath.
- Existing report links still open details correctly.
- The profile selector remains above filters/groups.

### Step 3: Tests

Add report-viewer tests for:

- multiple projects render as separate groups;
- multiple reports in the same project appear under one group;
- groups sort by latest run timestamp;
- filters apply before grouping;
- unknown/malformed project metadata renders a safe fallback;
- report detail/artifact routes still work from grouped cards.

### Step 4: Docs

Update `apps/report-viewer/README.md`:

- explain project-grouped report layout;
- note unknown project buckets from migration;
- clarify project grouping is read-only and does not imply project-level profile setup.

## Verification

Run:

```bash
npm run report-viewer:verify
```

Optionally run the local viewer and inspect `/reports` with migrated reports:

```bash
npm run report-viewer
```

or Tailscale:

```bash
npm run report-viewer:tailscale -- restart
```

## Out of scope

- Project-level profile switching.
- Editing project metadata in the viewer.
- Moving reports between projects from the UI.
- Permanent legacy flat-layout scanning.
- Browser automation unless HTML/server route tests are insufficient.

## Open questions

1. Should project groups be collapsible by default on mobile?
   - Initial recommendation: render as normal sections first; add collapse later if the page gets too long.
2. Should `/projects/:viewerProjectId` be implemented now?
   - Initial recommendation: defer unless grouping makes the page too heavy or users need shareable project-specific URLs.
3. Should group counts show total runs or filtered visible runs?
   - Initial recommendation: show visible filtered count first; total count can be added later.
