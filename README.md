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

## Installation

Clone this repo and configure pi to load the package/extensions.

Local clone extension paths:

```json
{
  "extensions": [
    "/path/to/pi-productive-extensions/extensions/delivery-state-machine",
    "/path/to/pi-productive-extensions/extensions/session-usage"
  ]
}
```

Package-style usage may also be supported by your pi setup:

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
