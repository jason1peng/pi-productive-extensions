# Session report schema v1

`session-report` is the expanded, local-only companion to
[`session-usage`](../extensions/session-usage/README.md). The
`/session-report` command and `session_report` tool read persisted parent and
Pi-subagents child JSONL and write `session-report.json` and `session-report.md`
to a private directory under `~/.pi/session-reports/` (mode `0700`/`0600`).
Reports are never written to the repository.

## Contract

The JSON envelope is deterministic for a fixed set of persisted JSONL bytes.
It has no collection timestamp, paths, prompts, arguments, raw messages,
credentials, GitLab data, or MR arrays.

```json
{
  "schemaVersion": 1,
  "reportType": "session-report",
  "status": "ok | partial | unavailable",
  "usage": {
    "status": "complete | partial | unknown",
    "parent": "UsageTotals | null",
    "subagents": "UsageTotals | null",
    "total": "UsageTotals | null"
  },
  "topology": {
    "parent": "SessionNodeReport",
    "children": ["SessionNodeReport"],
    "sessionCount": "number",
    "availableSessionCount": "number",
    "missingSessionCount": "number",
    "ephemeralSessionCount": "number",
    "unreadableSessionCount": "number",
    "compactedSessionCount": "number",
    "branchedSessionCount": "number",
    "branchPointCount": "number"
  },
  "tools": "ToolActivity | null",
  "skills": "SkillActivity | null",
  "evidence": "SessionReportEvidence"
}
```

`UsageTotals` retains the existing fields exactly: `input`, `output`,
`cacheRead`, `cacheWrite`, `totalTokens`, `cost`, `assistantMessages`, and
`sessionFiles`. Its token fallback remains numeric `totalTokens`, then numeric
`total`, then the component sum. A missing parent makes usage/activity
`unknown`/`null`; a missing child, malformed line, or compaction makes the
report `partial`. Observed totals in a partial report are lower-bound persisted
evidence, never fabricated zeroes.

`ToolActivity` contains `requested`, `persistedResults`, `failedResults`,
`missingResults`, `unmatchedResults`, `duplicateResults`, and a sorted
`byTool` map containing the same counters. Requested calls are counted from
persisted assistant tool-call items and persisted lifecycle records. A
matching lifecycle record is one logical request or result. Results are counted
from persisted `toolResult`/`tool_end` records and matched by their call ID.
Repeated calls/results remain visible in the counters.

`SkillActivity` has two independent metrics:

- `explicitInvocations`: explicit skill-tool invocation evidence, including a
  persisted machine `<skill name=...>` marker or explicit skill invocation
  record/tool.
- `skillFileReads`: persisted read-tool events whose explicit file/path argument has the exact basename `SKILL.md` (case-insensitive). Mentions in commands or unrelated metadata, and suffixes such as `SKILL.md.bak`, are not file-read evidence.

Each metric has `count`, sorted unique `names`, and `byName` counts. A skill
being merely discovered by the runtime is not counted as an invocation; only
the persisted machine marker/record is considered explicit evidence. Names are
normalized labels; arguments and prompt text are never retained.

Each `SessionNodeReport` records only safe topology metadata (`kind`, status,
opaque session/run labels, record/count fields, compaction/truncation/branch
counts, and whether a session header was present). `evidence.truncatedCount`
and each available node's `truncatedCount` count a persisted truncation marker;
truncation makes the report partial. Child evidence is canonical-only: recursively
discovered regular `session.jsonl` files below the exact child root derived from
the parent session path are included. Modern transcripts or records stored in
custom locations are not evidence; if such records are the only child source,
the report remains unavailable/partial rather than fabricating usage or activity.
Missing/ephemeral child launches are represented as nodes with `null` evidence
fields instead of zeroes. A persisted static delegation with no matching child
session is represented as an `unresolved-*` ephemeral node. Dynamic fanout bounds
such as `expand.maxItems` are not observed child counts: only persisted child
sources are included, so an unobserved or empty fanout does not fabricate nodes.
An unobserved dynamic fanout keeps `usage.subagents` null and `usage.status`
partial, even when the report itself remains `ok` because no incomplete child
source was discovered.

`status` is `ok` only when the parent and all discovered children are readable
and have no malformed, compacted, or truncated evidence. `partial` means some
evidence is incomplete but observed records are reportable. `unavailable` means
the parent session cannot be read or was not supplied. A path that does not
exist is reported as `missing`; other read failures are `unreadable`.

## Markdown companion

`session-report.md` uses fixed headings and sorted tool rows, including
unmatched and duplicate result counters. It is a human-readable projection of
the JSON contract and carries the same privacy boundary. Both files end with a
newline and are atomically replaced on each run.

The low-level `/session-usage-all`, `session_usage_all`, `UsageTotals`, and
`session-usage:request`/`session-usage:response` event payload are separate
contracts and are not extended by this report.
