# session-report

`session-report` is the expanded local companion to `session-usage`. It
provides `/session-report` and `session_report` and reads only persisted parent
and delegated child JSONL. The versioned schema is documented in
[`docs/session-report-schema-v1.md`](../../docs/session-report-schema-v1.md).
Child evidence is canonical-only: the extension recursively scans regular
`session.jsonl` files below the child root derived from the parent session path.
Modern transcripts and records stored in custom locations are not scanned; when
that is the only child evidence, the report remains unavailable or partial rather
than fabricating usage or activity. In a mixed static/dynamic fanout without a
persisted dynamic run-ID link, an empty outer directory cannot identify the
available child; the report conservatively treats available unlinked children as
dynamic evidence and retains unresolved static slots.

The report separates requested tool calls from persisted results and failures,
and separates explicit skill invocations from `SKILL.md` reads. Missing,
unreadable, malformed, and compacted evidence is represented as
`unavailable`/`partial`/`unknown`; it is never converted into fabricated zeroes.

Both `session-report.json` and `session-report.md` are written atomically under
`~/.pi/session-reports/<stable-session-key>/` with private permissions. A
repository path is rejected. Generated reports are not committed to this
repository.

The JSON and Markdown outputs omit prompts, arguments, raw messages, secrets,
filesystem paths, GitLab data, and MR arrays. Existing `/session-usage-all`,
`session_usage_all`, `UsageTotals`, and `session-usage` event payloads remain
unchanged.
