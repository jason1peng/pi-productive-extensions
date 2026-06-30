# report-viewer

Standalone local web app for pi delivery reports.

## Run

```bash
npm run report-viewer
```

The server binds to `127.0.0.1:8765` by default.

## Config

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

`agentCommand.promptMode` is intentionally unset by default, which disables agent execution. Set it to `"stdin"` only after confirming your local `pi` CLI supports non-interactive prompts from stdin.

Environment overrides:

```bash
REPORT_VIEWER_ROOTS=~/.pi/delivery-run,~/delivery-reports
REPORT_VIEWER_AGENT_BIN=pi
REPORT_VIEWER_AGENT_PROMPT_MODE=stdin
REPORT_VIEWER_HOST=127.0.0.1
REPORT_VIEWER_PORT=8765
REPORT_VIEWER_CSRF_TOKEN=<optional-fixed-local-token>
```

If no CSRF token is configured, the server generates one at startup and exposes it in a page meta tag for the local UI.

## Routes

- `/reports` — local report list UI.
- `/reports/:viewerReportId` — local report detail UI.
- `/reports/:viewerReportId/artifacts/*artifactPath` — sanitized local artifact viewer.
- `/api/reports` — report list API.

## Behavior

- Reads extension-owned `delivery-report.json` first.
- Falls back to legacy `00-delivery-summary.md` when JSON is missing.
- Stores app-owned metadata under each report directory in `.report-viewer/`.
- Rejects artifact path traversal and symlink escapes.
- Requires `x-report-viewer-token` for POST API routes.
- Requires `{ "confirmExecution": true }` on the run endpoint.
- Keeps agent execution disabled until `agentCommand.promptMode` / `REPORT_VIEWER_AGENT_PROMPT_MODE` is explicitly set to `stdin`.
- Uses argv-based process spawning for approved agent runs; unapproved improvements cannot run.
- Reconciles stale `running` records to `unknown`/`failed` on startup because child processes are not tracked across app restarts.
