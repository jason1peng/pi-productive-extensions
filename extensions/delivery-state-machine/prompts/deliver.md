Run the delivery state machine for this task:

{{task}}

User-scope artifact directory for this run: {{artifactDir}}

Use the `delivery_*` tools as source of truth to determine the current phase and next action. Do not rely on memory or skip ahead.

Start by calling `delivery_status`, then `delivery_next`.

Before implementation, unless this is the same task or an amended requirement, ensure repo work happens in a dedicated git worktree created from latest `main`. If this is non-git/non-repo work, record why the policy is not applicable.

For each returned phase:
- If `details.next.parallel` is present, launch all listed children in parallel using each entry's `agent/model/thinking/context`, `acceptance` when present, and unique `childPrompt`; save each child artifact separately, then aggregate all child outputs before calling `delivery_report` once for the phase.
- Otherwise, launch the requested subagent using `details.next.agent/model/thinking/context` and `details.next.acceptance` when present.
- Pass only `details.next.childPrompt` to the child for single-child phases. `details.next.prompt` mirrors the same value for compatibility.
- Delivery owns the phase artifact contract and verdict gate; when `acceptance: false` is present, pass it to the subagent launch instead of relying on pi-subagents attestation/acceptance reports.
- Save phase artifacts under the artifact directory.
- Before calling `delivery_report`, confirm each expected artifact exists, is non-empty, and starts with a verdict/result line. If a child returned inline output but did not write the expected artifact, save that output to the artifact path yourself.
- Do not report a phase as `PASS` when required child evidence is missing, stale, or unavailable; report `FAIL` with the artifact blocker instead, or `INCONCLUSIVE` for verification when evidence cannot prove pass/fail.
- After each single child finishes, call `delivery_report` with the verdict, evidence summary, and artifact reference.
- After all parallel children finish, write one clean aggregate artifact at the generic phase path (for example `03-review.md`) that links/summarizes each child artifact, then call `delivery_report` with the aggregate verdict, evidence summary, and only the aggregate artifact path. Do not pass semicolon-joined child artifact paths as the `artifact` value.

For `VERIFY`/`REVIEW` failures still within the original task or accepted plan, call `delivery_report` with `recommendedDecision=repair` so the state machine routes back to `IMPLEMENT` automatically.

For review results, do not blindly trust the verdict label if the evidence contradicts it. If the reviewer returns `PASS` or `PASS_WITH_NON_BLOCKING_NOTES` but includes findings that should be fixed in this delivery, report `REVIEW` as `FAIL` with `recommendedDecision=repair`.

Ask me only when repair would change scope, conflict with the plan, require product judgment, exceed max rounds, or need `accept_risk`, `stop`, or `defer`.

If `delivery_next` says `WAITING_DECISION`, ask me for a decision or use `delivery_decide` only when I already gave one.

Do not push or create an MR until `delivery_next` reaches `CLOSE`.
