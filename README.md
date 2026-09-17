# pi-productive-extensions

Personal pi extensions for productive coding workflows.

Documentation starts at [docs/index.md](docs/index.md). Repo-wide change standards live in [docs/principles.md](docs/principles.md).

## Extensions

### delivery-state-machine

Controlled delivery workflow for implementation tasks.

- Commands: `/deliver`, `/delivery-status`, `/delivery-summary`, `/delivery-reset`
- Tools: `delivery_start`, `delivery_next`, `delivery_report`, `delivery_decide`, `delivery_status`, `delivery_summary`, `delivery_reset`
- Details: [extensions/delivery-state-machine/README.md](extensions/delivery-state-machine/README.md)

### session-usage

Reports current pi session token/cost usage including pi-subagents child sessions.

- Command: `/session-usage-all`
- Tool: `session_usage_all`
- Details: [extensions/session-usage/README.md](extensions/session-usage/README.md)

### session-report

Generates a deterministic, privacy-safe report from persisted parent and delegated child session JSONL.

- Command: `/session-report`
- Tool: `session_report`
- Details: [docs/session-report-schema-v1.md](docs/session-report-schema-v1.md)

### git-cleanup

Post-merge housekeeping for local git worktrees.

- Command: `/cleanup`
- Details: [extensions/git-cleanup/README.md](extensions/git-cleanup/README.md)

## Apps

### report-viewer

Optional local dashboard for delivery reports. It scans `~/.pi/delivery-run` by default, prefers structured `delivery-report.json`, and falls back to legacy `00-delivery-summary.md`.

```bash
npm run report-viewer
```

To expose the viewer on your tailnet:

```bash
npm run report-viewer:tailscale -- start
```

Details are documented in [apps/report-viewer/README.md](apps/report-viewer/README.md).

## Installation

Clone this repo and configure pi to load the package from the clone root:

```json
{
  "packages": [
    "/path/to/pi-productive-extensions"
  ]
}
```

The package manifest loads `./extensions`, so any extension added under `extensions/<name>/index.ts` is discovered automatically on the next pi startup or `/reload`. You do not need to add each extension path to `settings.json`.

Git package usage is also supported:

```json
{
  "packages": [
    "git:github.com/jason1peng/pi-productive-extensions"
  ]
}
```

## Development

```bash
npm run verify
```

`npm run verify` runs the delivery-state-machine, session-usage, session-report, and report-viewer test suites. If the host-provided `pi-subagents` package is outside this checkout, set `PI_HOST_MODULE_ROOT` to its `node_modules` directory:

```bash
PI_HOST_MODULE_ROOT=/path/to/node_modules npm run verify
```
