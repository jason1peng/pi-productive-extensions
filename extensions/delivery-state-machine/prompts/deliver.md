Run the delivery state machine for this task:

{{task}}

User-scope artifact directory for this run: {{artifactDir}}

Use the `delivery_*` tools as source of truth to determine the current phase and next action. Do not rely on memory or skip ahead.

Start by calling `delivery_status`, then `delivery_next`.

A planning-only MR on a `plan/<slug>` branch may be created and submitted directly from the stable primary checkout without a dedicated planning worktree. After that plan is approved or merged, implementation and delivery must use a dedicated git worktree created from the latest fetched `main`, never from the planning branch. Otherwise, before implementation, unless this is the same task or an amended requirement, ensure repo work happens in a dedicated git worktree created from the latest fetched `main`. If this is non-git/non-repo work, record why the policy is not applicable.

For each returned phase:
- If `details.next.parallel` is present, launch all listed children in parallel using each entry's `agent/model/thinking/context`, `acceptance` when present, `output`/`outputMode` when present, and unique `childPrompt`; save each child artifact separately at `details.next.parallel[].artifact`, then aggregate all child outputs before calling `delivery_report` once for the phase.
- Otherwise, launch the requested subagent using `details.next.agent/model/thinking/context`, `details.next.acceptance`, and `details.next.output`/`outputMode` when present; its result must be written at `details.next.artifact`.
- Pass only `details.next.childPrompt` to the child for single-child phases. `details.next.prompt` mirrors the same value for compatibility.
- Delivery owns the phase artifact contract and verdict gate; when `acceptance: false` is present, pass it to the subagent launch instead of relying on pi-subagents attestation/acceptance reports.
- Save phase artifacts under the artifact directory.
- Before calling `delivery_report`, confirm each expected artifact is a non-empty regular file at its exact planned path, starts with a phase-valid `RESULT` line, and contains the required headings. For parallel phases, every `details.next.parallel[].artifact` must be valid. If a child returned inline output, save it to that exact planned path; alternate and semicolon-joined paths are rejected.
- Do not report a phase as `PASS` when required child evidence is missing, stale, or unavailable; report `FAIL` with the artifact blocker instead, or `INCONCLUSIVE` for verification when evidence cannot prove pass/fail.
- After each single child finishes, call `delivery_report` with the verdict, evidence summary, artifact reference, and child-native usage metadata when the subagent result exposes it. Prefer `usageDelta`; otherwise pass `subagentSessionFile` or `subagentRunId` so the state machine can parse child session usage and keep parent overhead separate.
- After all parallel children finish, call `delivery_report` with the aggregate verdict and evidence summary. Omit `artifact` or provide only the exact attempt-specific aggregate path named by `details.next.reportInstruction`; the state machine atomically regenerates and validates the aggregate from the planned child artifacts. Include `stepUsage` entries for child-native usage metadata, keyed by `childIndex`, `stepId`, or child artifact. Prefer exact `usageDelta`; otherwise pass each child's `subagentSessionFile` or `subagentRunId` so delivery can parse usage without double-counting the aggregate row.

Auto-repair only a supported must-fix `VERIFY`/`REVIEW` finding that cites the accepted requirement or invariant violated, a realistic reproducer inside the supported operating model, and the safeguard/test gap. For those failures, call `delivery_report` with `recommendedDecision=repair` so the state machine routes back to `IMPLEMENT` automatically. Never downgrade a genuine in-scope defect because it is inconvenient or expensive.

Do not blindly trust a verdict label when its evidence contradicts its classification. If a reviewer returns `PASS` or `PASS_WITH_NON_BLOCKING_NOTES` but includes a supported must-fix finding with that evidence, report `REVIEW` as `FAIL` with `recommendedDecision=repair`. Preserve unsupported/adversarial scenarios and optional hardening as non-blocking notes rather than silently dropping them.

Ask me before adopting a new product, safety, concurrency, or threat-model contract. Ask before reporting or repairing when that contract decision is necessary to judge or continue the task; otherwise keep the contract suggestion visible and non-gating. Also ask when repair would conflict with the accepted plan, exceed max rounds, or need `accept_risk`, `stop`, or `defer`.

If pi-subagents reports spawn exhaustion, do not report PASS and do not substitute parent self-verification for a required independent gate. Report the blocked gate and state that a new Pi session is required.

If `delivery_next` says `WAITING_DECISION`, ask me for a decision or use `delivery_decide` only when I already gave one.

Do not push or create an MR until `delivery_next` reaches `CLOSE`.
