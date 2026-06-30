# report-viewer

Standalone local web app for pi delivery reports.

## Run

```bash
npm run report-viewer
```

The server binds to `127.0.0.1:8765` by default.

## Run over Tailscale

Use this when you want to open the report viewer from another device on your tailnet.

1. Find this machine's Tailscale IP:

```bash
tailscale ip -4
```

If the `tailscale` CLI is not installed, inspect network interfaces and look for the `100.x.y.z` address:

```bash
ifconfig | grep -A3 -E 'tailscale|utun|100\.'
```

2. Start the viewer bound to that IP:

```bash
mkdir -p /tmp/pi-report-viewer
REPORT_VIEWER_HOST=<tailscale-ip> \
REPORT_VIEWER_PORT=8765 \
REPORT_VIEWER_ROOTS=$HOME/.pi/delivery-run \
nohup npm run report-viewer > /tmp/pi-report-viewer/report-viewer.log 2>&1 &
sleep 1
lsof -tiTCP:8765 -sTCP:LISTEN > /tmp/pi-report-viewer/report-viewer.pid
```

3. Open from any device that can reach your tailnet:

```txt
http://<tailscale-ip>:8765/reports
```

4. Check or stop the server:

```bash
tail -f /tmp/pi-report-viewer/report-viewer.log
kill $(cat /tmp/pi-report-viewer/report-viewer.pid)
```

For example, if the Tailscale IP is `100.126.13.87`, open:

```txt
http://100.126.13.87:8765/reports
```

Security note: this exposes the app to devices that can reach that Tailscale IP. Keep agent execution disabled unless you intentionally configure `REPORT_VIEWER_AGENT_PROMPT_MODE=stdin` after confirming your local `pi` CLI supports non-interactive stdin prompts.

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

## Convert legacy Markdown reports

New delivery runs write `delivery-report.json` automatically. Older runs may only have `00-delivery-summary.md`; convert one with:

```bash
npm run convert-report -- ~/.pi/delivery-run/<legacy-run-directory>
```

The converter is deterministic and best-effort. It preserves unknown fields as null/empty values and writes `source: "legacy-markdown-conversion"`. It will not replace an existing `delivery-report.json` unless you pass `--overwrite`:

```bash
npm run convert-report -- ~/.pi/delivery-run/<legacy-run-directory> --overwrite
```

## Routes

- `/reports` — local report list UI.
- `/reports/:viewerReportId` — local report detail UI with dashboard cards, timeline, artifacts, improvement forms, prompt preview, and run controls.
- `/reports/:viewerReportId/artifacts/*artifactPath` — sanitized local artifact viewer.
- `/api/reports` — report list API.
- `/api/reports/:viewerReportId/runs` — agent run status API.

## Behavior

- Reads extension-owned `delivery-report.json` first.
- Falls back to legacy `00-delivery-summary.md` when JSON is missing.
- Stores app-owned metadata under each report directory in `.report-viewer/`.
- Includes UI forms for creating, approving, rejecting, previewing, and running retro improvements.
- Includes a deterministic `convert-report` helper for legacy Markdown-only runs.
- Rejects artifact path traversal and symlink escapes.
- Requires `x-report-viewer-token` for POST API routes.
- Requires `{ "confirmExecution": true }` on the run endpoint.
- Keeps agent execution disabled until `agentCommand.promptMode` / `REPORT_VIEWER_AGENT_PROMPT_MODE` is explicitly set to `stdin`.
- Uses argv-based process spawning for approved agent runs; unapproved improvements cannot run.
- Reconciles stale `running` records to `unknown`/`failed` on startup because child processes are not tracked across app restarts.
