# pi-productive-extensions

Personal pi extensions for productive coding workflows.

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

Details and future approval/execution workflow are tracked in [docs/plans/report-viewer-and-structured-reports.md](docs/plans/report-viewer-and-structured-reports.md).

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
