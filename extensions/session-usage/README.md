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
- token total using the shared fallback policy: numeric `usage.totalTokens`, then numeric `usage.total`, then `input + output + cacheRead + cacheWrite`
- `usage.cost.total`
- Assistant message count with usage

The parser is shared with `delivery-state-machine` so session usage reports and delivery summaries account for tokens consistently.

## Limitations

- Uses recorded `usage.cost.total`; it does not reprice historical usage.
- Only counts assistant messages with `message.usage`.
- Does not allocate usage by task or phase.
- Depends on session files being persisted.
- Subagent accounting is complete only for child sessions under the pi-subagents parent-session layout.

## In-process event contract

`session-usage` also exposes a privacy-safe usage snapshot to other extensions
running in the **same Pi process** through Pi's shared event bus (`pi.events`).
This is the integration surface used by separately installed consumers such as
the local Slack bridge.

- Request event: `session-usage:request` with payload `{ requestId: string }`.
- Response event: `session-usage:response` with payload
  `{ requestId, status, parent, subagents, total, subagentSessions }`.
- Every totals object contains `input`, `output`, `cacheRead`, `cacheWrite`,
  `totalTokens`, `cost`, `assistantMessages`, and `sessionFiles`.
- `status: "ok"` means the parent session file was available and the values are
  recorded usage at collection time. It does not claim all active child work has
  settled.
- `status: "unavailable"` means the parent session file was missing or
  unreadable; consumers must show an unavailable/stale state, not a fabricated
  zero or misleading partial total.
- `subagentSessions` is the number of discovered child sessions with recorded
  assistant usage.
- The response contains no filesystem paths, raw messages, transcripts, or
  credentials.

### Same-Pi-process prerequisite

The event bus is in-process only. A consumer can only receive a response if it
is loaded as a Pi extension in the same Pi process that owns the session file.
A consumer in a separate process or a separate machine cannot use this
contract and must not read the session file path from another package.

### Session lifecycle scoping

The handler captures the active session manager on `session_start` and clears it
on `session_shutdown`. A request issued after a session has shut down and before
the next `session_start` returns `status: "unavailable"` rather than the previous
session's totals. After a session switch, the next `session_start` reinitializes
the handler with the new session manager, so responses reflect the current
session only.

### Recorded-so-far semantics

The snapshot is a point-in-time reading of what has been **persisted** to disk
at collection time. It is not final billing, it does not reprice historical
records, and it may lag behind in-flight work that has not yet been written.
Child sessions contribute only what they have actually persisted.

### Consumer pseudocode

```text
requestId = randomId()
unsubscribe = pi.events.on("session-usage:response", (data) => {
  snapshot = data as SessionUsageSnapshot
  if snapshot.requestId !== requestId: return
  unsubscribe()
  if snapshot.status === "unavailable": showUnavailable()
  else: render(snapshot.parent, snapshot.subagents, snapshot.total, snapshot.subagentSessions)
})
pi.events.emit("session-usage:request", { requestId })
```

The handler performs local JSONL parsing only. It never appends to the Pi
session, sends a user message, or triggers a model turn.

## Examples

Ask pi:

```text
/session-usage-all
```

or:

```text
How many tokens and how much cost has this session used including subagents?
```
