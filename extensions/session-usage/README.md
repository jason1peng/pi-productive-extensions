# session-usage

`session-usage` reports token and cost usage for the current pi session, including child sessions created under the current session's subagent directory layout.

## Command

```text
/session-usage-all
```

Shows a markdown report in the UI notification stream.

## Tool

```text
session_usage_all
```

Returns the same report as tool text and includes structured `details` with per-session rows and summed totals.

## Data source

The extension reads persisted pi session JSONL files directly:

1. The current parent session file from `ctx.sessionManager.getSessionFile()`.
2. Recursively discovered child `session.jsonl` files below the parent-session-derived directory.
3. `message.usage` records inside JSONL entries where the role is `assistant`.

This extension does not import or call pi-subagents directly.

Parent usage comes from pi core session JSONL.

Subagent usage is discovered by scanning the child session directory layout introduced by pi-subagents:

```text
<parent-session>.jsonl
<parent-session>/<runId>/run-0/session.jsonl
```

If child sessions are stored somewhere else, they are not included.

## Fields summed

- `usage.input`
- `usage.output`
- `usage.cacheRead`
- `usage.cacheWrite`
- `usage.totalTokens`
- `usage.cost.total`
- Assistant message count with usage

## Limitations

- Uses recorded `usage.cost.total`; it does not reprice historical usage.
- Only counts assistant messages with `message.usage`.
- Does not allocate usage by task or phase.
- Depends on session files being persisted.
- Subagent accounting is complete only for child sessions under the pi-subagents parent-session layout.

## Examples

Ask pi:

```text
/session-usage-all
```

or:

```text
How many tokens and how much cost has this session used including subagents?
```
