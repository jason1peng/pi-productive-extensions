# Report Viewer and Structured Delivery Reports Plan

## Goal

Add reliable, app-readable delivery report output to the existing `delivery-state-machine` extension, then build an optional standalone local web app that reads those extension outputs, displays delivery reports, and later lets a single local user approve retro improvements and directly invoke `pi` for approved work.

## Decisions

- The extension remains the source of delivery report artifacts.
- Always generate structured JSON from TypeScript state; do not make JSON output configurable because it does not require extra model output tokens.
- Keep the existing Markdown summary output for compatibility and human reading.
- The web app is standalone and optional; normal pi extension workflows must continue without it.
- The web app reads `delivery-report.json` first and falls back to `00-delivery-summary.md` for legacy runs.
- Approval/execution metadata created by the web app lives under each artifact directory in `.report-viewer/` and does not mutate extension-owned report files.
- Initial execution model is local single-user and direct `pi` invocation, not the delivery state machine.

## Current extension behavior

`extensions/delivery-state-machine/index.ts` currently:

- creates delivery artifact directories under `~/.pi/delivery-run` by default;
- supports configurable `artifactRoot` via:
  - `~/.pi/agent/extensions/delivery-state-machine.json`,
  - `<repo>/.pi/delivery-state-machine.json`,
  - `PI_DELIVERY_ARTIFACT_ROOT`;
- writes `00-delivery-summary.md` from `writeJourneyReport()`;
- stores in-memory/session state with fields already suitable for JSON export, including `task`, `phase`, `artifactDir`, `cwd`, `gitBranch`, `gitRoot`, `history`, `steps`, `acceptedRisks`, `pendingIssue`, and usage data.

## Phase 1: Extension structured report output

### Scope

Add `delivery-report.json` generation alongside the existing Markdown summary.

### Implementation constraints from plan review

- Use one shared render/write path for Markdown and JSON so repeated summary calls do not create divergent outputs.
- Avoid calling expensive usage collection more times than current behavior requires.
- Write JSON atomically with `delivery-report.json.tmp-<pid>` followed by rename, so the viewer never reads a partial file.
- Generate JSON from cloned/plain state only; do not include functions or non-serializable objects.

### Required behavior

- Every time the extension writes or refreshes `00-delivery-summary.md`, it also writes `<artifactDir>/delivery-report.json`.
- JSON generation is deterministic TypeScript serialization from extension state, not LLM-generated content.
- Existing Markdown report content and paths remain unchanged.
- Existing config behavior for `artifactRoot` and phase max rounds remains unchanged.
- Existing commands/tools continue to return compatible responses.

### JSON schema v1

Initial file:

```json
{
  "schemaVersion": 1,
  "source": "delivery-state-machine",
  "id": "30-06-2026-example-task",
  "task": "Example task",
  "status": "DONE",
  "phase": "DONE",
  "artifactDir": "/Users/example/.pi/delivery-run/30-06-2026-example-task",
  "cwd": "/repo/path",
  "gitBranch": "main",
  "gitRoot": "/repo/path",
  "updatedAt": 1782780000000,
  "generatedAt": 1782780000123,
  "summaryMarkdownPath": "/Users/example/.pi/delivery-run/30-06-2026-example-task/00-delivery-summary.md",
  "history": [],
  "steps": [],
  "acceptedRisks": [],
  "pendingIssue": null,
  "usage": {
    "currentSessionTotals": null,
    "sinceDeliveryStart": null,
    "attribution": "unavailable"
  }
}
```

Recommended TypeScript shape:

```ts
interface DeliveryReportJsonV1 {
  schemaVersion: 1;
  source: "delivery-state-machine" | "legacy-markdown-conversion";
  id: string;
  task: string | null;
  status: Phase;
  phase: Phase;
  artifactDir: string;
  cwd?: string;
  gitBranch?: string;
  gitRoot?: string;
  createdAt?: number;
  updatedAt: number;
  generatedAt: number;
  summaryMarkdownPath: string;
  history: HistoryEntry[];
  steps: DeliveryStep[];
  acceptedRisks: string[];
  pendingIssue: PendingIssue | null;
  usage: {
    currentSessionTotals: UsageTotals | null;
    sinceDeliveryStart: UsageTotals | null;
    attribution: "exact" | "best-effort" | "phase-aggregate" | "unavailable";
  };
}
```

`id` should be stable for the artifact directory. Prefer `path.basename(artifactDir)` for v1.

`updatedAt` should come from `state.updatedAt`; `generatedAt` should be the report file write time. If no reliable usage data exists, use `null` plus `attribution: "unavailable"`; do not infer zero cost.

### Candidate implementation points

- Keep `DeliveryReportJsonV1` in a small module such as `extensions/delivery-state-machine/report-schema.ts` if the viewer/converter will import the type; otherwise keep it internal for the first extension-only change.
- Add `buildStructuredReport(state, ctx, summaryMarkdownPath, generatedAt, usageSnapshot): DeliveryReportJsonV1`.
- Add `writeReportArtifacts(state, ctx): { markdownPath?: string; jsonPath?: string; markdown: string }` as the single write path.
- Have `writeReportArtifacts()` collect usage once, pass that usage snapshot into Markdown formatting and JSON building, write Markdown, then atomically write JSON.
- Refactor `formatJourneyReport(state, ctx)` to accept an optional usage snapshot so it does not call `collectSessionUsage(ctx)` again when the caller already collected usage.
- Refactor `writeJourneyReport()` / `formatDeliverySummary()` callers to avoid duplicate report generation within one command response.
- If Markdown succeeds but JSON write fails, surface a warning in the command response/details without failing the whole delivery summary; keep existing Markdown compatibility.
- Ensure `delivery_next`, final `delivery_report`, `delivery_status`, and `delivery_summary` paths that already refresh summary still refresh JSON when applicable.

### Tests

Update `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts` or add focused tests to verify:

- default behavior still writes/returns Markdown summary as before;
- `delivery-report.json` is written in the artifact directory;
- JSON contains `schemaVersion: 1`, `source: "delivery-state-machine"`, task, phase/status, artifactDir, steps, history, summaryMarkdownPath, and the v1 usage object;
- returned Markdown matches written Markdown for summary commands;
- one summary command does not create divergent Markdown/JSON snapshots;
- JSON generation does not require parsing Markdown;
- malformed/unavailable usage data is represented as nullable fields plus `attribution: "unavailable"`, not as fake zero cost.

### Verification commands

```bash
npm run verify
```

Also manually inspect a sample artifact directory after a delivery summary is generated.

## Phase 2: Standalone report viewer app

### Scope

Create an optional local web app that reads extension artifact output and displays reports.

Location:

```txt
apps/report-viewer/
```

### Stack and scripts

Use a small local Node/Bun TypeScript server with no database. The server exposes JSON APIs, serves static HTML/CSS/JS, reads report files from disk, and later spawns `pi` directly. Avoid a frontend framework until the workflow needs it.

Add package scripts:

```json
{
  "report-viewer": "bun apps/report-viewer/src/server.ts",
  "report-viewer:verify": "bun apps/report-viewer/tests/report-viewer.test.ts"
}
```

`npm run verify` should eventually include the report viewer verification once the app exists.

### Required behavior

- Load app config from a simple local config file and environment variables.
- Default report root: `~/.pi/delivery-run`.
- Bind to `127.0.0.1` by default.
- Scan configured roots for child directories.
- Treat a directory as a report if it contains `delivery-report.json` or legacy `00-delivery-summary.md`.
- Prefer `delivery-report.json`.
- Fall back to legacy Markdown rendering when JSON is absent.
- Minimal legacy parsing guarantee: directory-derived id, directory mtime, and rendered Markdown. Any extra Markdown field extraction is optional/best-effort and must be labeled `source: "legacy-markdown"`.
- Render phase artifact Markdown files linked from JSON `steps[].artifact` and conventional names when present.
- Serve only files inside configured report roots and the selected artifact directory; reject `..`, symlink escapes, and unrelated absolute paths.

### Suggested app config

Default config path:

```txt
~/.pi/agent/extensions/report-viewer.json
```

Example:

```json
{
  "reportRoots": ["~/.pi/delivery-run"],
  "agentCommand": {
    "bin": "pi",
    "args": [],
    "promptMode": "stdin"
  }
}
```

`agentCommand.promptMode` is unset by default. Set it to `"stdin"` only after confirming the local `pi` CLI supports non-interactive prompts from stdin; otherwise the run endpoint stays disabled.

Precedence: environment variables override config file values; config file values override defaults.

Environment overrides can be added later, for example:

```bash
REPORT_VIEWER_ROOTS=~/.pi/delivery-run,~/delivery-reports
REPORT_VIEWER_AGENT_BIN=pi
REPORT_VIEWER_AGENT_PROMPT_MODE=stdin
```

### Report identity and artifact paths

Viewer report IDs must be unique across multiple roots. Use a URL-safe encoded ID derived from `{rootIndex}:{relativeReportDirectory}` instead of only `path.basename(artifactDir)`. Keep the extension JSON `id` for display and cross-reference, not as the sole route key.

Artifact path normalization rules:

- URLs in `steps[].artifact` are shown as external links, never served as local files.
- Absolute paths are served only if their realpath is inside the selected report artifact directory or one configured report root.
- Relative paths are resolved against the selected report artifact directory.
- Nested paths are allowed only after realpath containment checks.
- Encoded `..`, symlink escapes, and unrelated absolute paths are rejected.

### UI pages

```txt
/reports
/reports/:viewerReportId
/reports/:viewerReportId/artifacts/*artifactPath
```

`/reports` should show:

- task or directory name;
- status/phase;
- artifact directory;
- updated time;
- whether source is JSON or legacy Markdown.

`/reports/:reportId` should show:

- task summary;
- current status;
- phase timeline from `steps`;
- accepted risks and pending issue if any;
- artifact links;
- rendered `00-delivery-summary.md` when present;
- raw JSON toggle for debugging.

### Legacy Markdown fallback

For legacy runs without JSON:

- Read raw Markdown as text and render through a sanitizer/escaping path; do not trust embedded HTML from report files.
- Render `00-delivery-summary.md` as the primary content.
- Best-effort extract task, artifact directory, phase counts, and timeline tables only when straightforward.
- Mark parsed fields as `source: "legacy-markdown"` so the UI does not imply perfect structure.
- Do not use LLM conversion in the default viewer path.

## Phase 3: Retro improvement approval metadata

### Scope

Let a local user create, approve, or reject retro improvement candidates from a report.

### Storage

The app owns metadata under:

```txt
<artifactDir>/.report-viewer/improvements.json
```

Example:

```json
[
  {
    "id": "imp_001",
    "title": "Improve verification instructions",
    "description": "Retro noted that verification missed an important runtime path.",
    "sourceArtifact": "05-retro.md",
    "sourceText": "...",
    "risk": "low",
    "status": "proposed",
    "createdAt": "2026-06-30T00:00:00.000Z",
    "approvedAt": null,
    "rejectedAt": null,
    "approvalNote": null
  }
]
```

### Status flow

```txt
proposed -> approved -> running -> completed
proposed -> rejected
running -> failed
```

### Required behavior

- User can manually create an improvement from retro artifact text.
- User can approve or reject an improvement.
- Rejected improvements cannot be run.
- Approval status persists in `.report-viewer/improvements.json`.

## Phase 4: Direct pi invocation for approved improvements

### Scope

Allow the local user to run `pi` for an approved retro improvement from the app.

### Execution design

- Use `child_process.spawn` or `execFile`, never shell string execution.
- Store `agentCommand` as an executable plus fixed args, not as an arbitrary shell command.
- Pass prompt content through stdin or a temporary prompt file only after confirming the supported pi CLI mode during implementation.
- Treat v1 as non-interactive execution. If the installed `pi` CLI cannot run non-interactively, disable the Run button and show setup guidance instead of spawning an interactive process from the server.
- Default execution cwd should be the report `gitRoot` when present, otherwise report `cwd`, otherwise disabled until the user chooses a cwd.

### Safety gates

- Improvement must be `approved`.
- App must show generated prompt preview.
- User must explicitly confirm execution with a request body such as `{ "confirmExecution": true }`.
- App must use POST-only state-changing endpoints and a local CSRF/session token even on localhost.
- App must record command argv, cwd, start/end time, exit code, status, and log path.
- Only one active run per improvement is allowed unless the user explicitly retries after failure/completion.
- On app restart, any previously `running` process without a live child process should be marked `failed` or `unknown` with a note.
- Prompt must instruct pi to use a dedicated git worktree from latest `main` when repo work is applicable.

### Run storage

```txt
<artifactDir>/.report-viewer/agent-runs.json
<artifactDir>/.report-viewer/runs/<runId>.log
```

Example run record:

```json
{
  "id": "run_001",
  "improvementId": "imp_001",
  "status": "running",
  "command": "pi ...",
  "cwd": "/repo/path",
  "startedAt": "2026-06-30T00:00:00.000Z",
  "endedAt": null,
  "outputLogPath": ".report-viewer/runs/run_001.log",
  "resultSummary": null
}
```

### Prompt requirements

Generated prompt should include:

- path to `delivery-report.json`;
- path to Markdown summary and relevant phase artifacts;
- improvement title and description;
- expected scope boundaries;
- verification expectations;
- instruction to report changed files, commands run, validation output, residual risks;
- instruction to avoid unrelated cleanup.

## Phase 5: Legacy conversion helper

### Scope

Provide a way to create `delivery-report.json` for old runs.

### Preferred first implementation

Deterministic converter:

```bash
npm run convert-report -- ~/.pi/delivery-run/30-06-2026-task
```

Behavior:

- read `00-delivery-summary.md`;
- parse best-effort fields;
- write `delivery-report.json` with `source: "legacy-markdown-conversion"` or similar metadata;
- preserve unknown fields as `null` rather than inventing values.

### Optional later implementation

Prompt-assisted converter for messy reports only, behind explicit user action because it consumes model tokens.

## Acceptance criteria

- `npm run verify` passes after extension changes.
- Existing delivery Markdown summary remains compatible.
- New delivery summaries produce `delivery-report.json` without asking agents for extra output.
- JSON writes are atomic and generated from extension state, not Markdown parsing.
- Report viewer can list and open JSON-backed reports.
- Report viewer can display legacy Markdown-backed reports with minimal guaranteed metadata.
- Report viewer tests cover scanning, unique IDs across multiple roots, JSON preference, legacy fallback, sanitized Markdown rendering, path traversal rejection including symlinks/encoded `..`/absolute paths, metadata persistence, approval gates, and unapproved-run rejection.
- Approval state is stored separately from extension-owned output.
- Direct pi execution is impossible for unapproved improvements.
- Direct pi execution uses argv-based process spawning, not shell interpolation.
- Direct pi execution records a local run log and status.

## Out of scope for initial delivery

- Remote hosting.
- Multi-user approval.
- Authentication.
- Database-backed persistence.
- Automatic retro extraction via LLM.
- Running improvement work through the delivery state machine.
- Removing Markdown output.

## Resolved implementation decisions

- Web stack: small local Bun/Node TypeScript server with static UI, no database, no frontend framework initially.
- Launch command: `npm run report-viewer` for v1.
- Direct invocation: non-interactive only for v1; execution is disabled by default and enabled only when config/env sets `agentCommand.promptMode` / `REPORT_VIEWER_AGENT_PROMPT_MODE` to `stdin` after local CLI confirmation.
- Execution cwd: prefer report `gitRoot`, then report `cwd`; otherwise require user selection.

## Remaining open questions

- Should a future polished UI add forms/buttons for create/approve/run flows, or keep those as API-only until the workflow is exercised manually?

## Additional implementation decisions from delivery

- State-changing API routes require `x-report-viewer-token`; the token is configured by `REPORT_VIEWER_CSRF_TOKEN`, config file `csrfToken`, or generated at startup.
- App-created execution prompts are written into `.report-viewer/runs/<runId>-prompt.md` for auditability.
- Run execution requires both local CSRF token and explicit `{ "confirmExecution": true }` confirmation.
- Stale `running` run records are reconciled on startup to `unknown`, and matching running improvements are marked `failed`, because child processes are not tracked across app restarts.

## Reviewer feedback incorporated

Two plan-review passes were run with `plan-reviewer`. The plan was updated to address the major findings:

- concrete app stack and scripts;
- single extension report write path;
- atomic JSON writes;
- one usage snapshot shared by Markdown and JSON;
- consistent JSON schema example/interface;
- unique viewer IDs for multiple roots;
- safe artifact path normalization;
- Markdown sanitization;
- argv-based `pi` execution with local safety gates;
- app verification coverage.
