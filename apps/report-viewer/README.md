# report-viewer

Standalone local web app for pi delivery reports.

## Run

```bash
npm run report-viewer
```

The server binds to `127.0.0.1:8765` by default.

## Run over Tailscale

Use this when you want to open the report viewer from another device on your tailnet. The helper script autodetects this machine's Tailscale IPv4 address with `tailscale ip -4`, binds the server to that address, and records logs/PID files under `/tmp/pi-report-viewer` by default.

```bash
npm run report-viewer:tailscale -- start
npm run report-viewer:tailscale -- status
npm run report-viewer:tailscale -- url
npm run report-viewer:tailscale -- logs
npm run report-viewer:tailscale -- stop
```

Open the printed URL from any device that can reach your tailnet:

```txt
http://<tailscale-ip>:8765/reports
```

For example, if the Tailscale IP is `100.126.13.87`, open:

```txt
http://100.126.13.87:8765/reports
```

Useful overrides:

```bash
REPORT_VIEWER_HOST=100.x.y.z npm run report-viewer:tailscale -- start
REPORT_VIEWER_PORT=9876 npm run report-viewer:tailscale -- restart
REPORT_VIEWER_ROOTS=$HOME/.pi/delivery-run,~/other-reports npm run report-viewer:tailscale -- start
REPORT_VIEWER_STATE_DIR=/tmp/pi-report-viewer npm run report-viewer:tailscale -- status
```

If the `tailscale` CLI is not installed, inspect network interfaces and look for the `100.x.y.z` address, then pass it with `REPORT_VIEWER_HOST`:

```bash
ifconfig | grep -A3 -E 'tailscale|utun|100\.'
REPORT_VIEWER_HOST=<tailscale-ip> npm run report-viewer:tailscale -- start
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

The delivery profile selector reads delivery-state-machine config under the resolved pi agent directory. By default this is `~/.pi/agent`; set `PI_CODING_AGENT_DIR` to point the viewer at a different pi agent dir. If `PI_DELIVERY_PROFILE` is set, the viewer displays that environment override as the currently effective profile while still allowing the saved global default to be changed for future runs without the override.

If no CSRF token is configured, the server generates one at startup and exposes it in a page meta tag for the local UI.

## Routes

- `/reports` — local report list UI, including the global delivery profile selector and read-only project-grouped report sections.
- `/api/delivery-profiles/global` — effective built-in/global delivery profile definitions and active selection.
- `/api/delivery-profiles/global/active` — CSRF-protected POST endpoint that atomically writes the global `active-profile.json` selection.
- `/reports/:viewerReportId` — local report detail UI.
- `/reports/:viewerReportId/artifacts/*artifactPath` — sanitized local artifact viewer.
- `/api/reports` — report list API.

## Behavior

- Scans project-layout report roots: `<reportRoot>/projects/<project-id>/runs/<run-id>` and reads `<reportRoot>/projects/<project-id>/project.json` when available.
- Groups `/reports` by project after applying filters, with each group showing project name/id, root or git root, git remote, visible run count, and latest run timestamp when that metadata is available.
- Treats project grouping as read-only UI organization; it does not add project-level profile/model setup or write to project roots.
- Shows incomplete or malformed project metadata as an explicit unknown/inferred project group instead of failing the report list. These buckets commonly come from migrated legacy flat reports.
- Does not scan old flat report directories directly. Migrate them once with:

  ```bash
  npm run report-viewer:migrate -- ~/.pi/delivery-run          # dry-run
  npm run report-viewer:migrate -- ~/.pi/delivery-run --apply  # copy into project layout
  ```

  The helper preserves all run files, including `.report-viewer/` metadata, and upgrades copied `delivery-report.json` files to schemaVersion 2 when possible.
- Reads extension-owned `delivery-report.json` first. The stable schema v2 contract is documented in [../../docs/delivery-report-schema-v2.md](../../docs/delivery-report-schema-v2.md).
- Falls back to `00-delivery-summary.md` when JSON is missing inside a project-layout run directory.
- Stores app-owned metadata under each report directory in `.report-viewer/`.
- Rejects artifact path traversal and symlink escapes.
- Lists built-in delivery profiles when no custom global `phase-launches.json` exists.
- Switches only the global active delivery profile by writing `active-profile.json` under the resolved pi agent dir; project files are never edited for profile/model setup.
- Uses atomic temp-file plus rename writes for profile selection.
- Requires `x-report-viewer-token` for POST API routes.
- Requires `{ "confirmExecution": true }` on the run endpoint.
- Keeps agent execution disabled until `agentCommand.promptMode` / `REPORT_VIEWER_AGENT_PROMPT_MODE` is explicitly set to `stdin`.
- Uses argv-based process spawning for approved agent runs; unapproved improvements cannot run.
- Reconciles stale `running` records to `unknown`/`failed` on startup because child processes are not tracked across app restarts.
