---
phase: VERIFY
---

## Orchestrator instruction

Launch the configured verifier for verification round {{verifyRound}}/{{maxRepairRounds}}.

## Child prompt

Independently verify this task. Be read-only: do not edit source files.

Instructions:
- Verify behavior independently against the requirements and candidate diff. Investigate broadly, but adjudicate findings against this boundary, in precedence order: the accepted user task and explicit decisions; documented product or repository invariants; the accepted implementation plan; the documented supported operating and threat model; and explicit exclusions. A lower-level plan or exclusion cannot excuse violating a higher-level accepted requirement or invariant.
- Preserve every meaningful concern in the report using these destinations: a requirement or invariant violation is blocking; a realistic regression in the supported workflow is blocking; an unsupported/adversarial scenario or optional hardening is a non-blocking note by default; and a potential product, safety, concurrency, or threat-model contract change requires parent/user judgment. A contract question pauses delivery only when its decision is necessary to judge or continue the task; otherwise keep the suggestion visible and non-gating.
- Every must-fix finding must identify the exact accepted requirement or invariant violated, a realistic reproducer inside the supported operating model, and why existing safeguards and tests are insufficient. Do not downgrade a genuine in-scope defect because repair is inconvenient or expensive.
- A missing plan item is blocking when a higher-level accepted requirement or invariant requires it. Conversely, do not make a stronger operating or threat model mandatory merely because it would be safer.
- Treat realistic data loss within the supported workflow as blocking. Treat unsupported concurrency, hostile filesystem mutation, broader threat models, and optional defense in depth as non-blocking unless the accepted contract includes them.
- Inspect candidate completeness with git status/diff when working in a git repository. If required source, test, config, script, or doc files are untracked or missing from the candidate diff, treat that as a blocker even if the working tree behavior passes.
- For cleanup, revert, or existing-MR work, identify the intended review base and distinguish changed surfaces that need behavioral proof from protected surfaces that need preservation sentinels, such as zero-diff checks versus base.
- Identify the externally observable behavior and the real consumer path that should observe the change, such as a CLI command, HTTP route, UI flow, background job, SDK call, tool call, message handler, or generated artifact. Exercise that path end-to-end when feasible.
- Treat internal state inspection, setup endpoint checks, database rows, config files, logs, mocks, and source-code shape as supporting evidence, not sufficient proof of behavioral correctness unless the task is explicitly internal-only.
- For setup, configuration, or control-plane changes, verify the write/configuration operation and the downstream runtime/data-plane behavior that consumes it.
- For scoped state or isolation-sensitive changes involving request context, identity, tenancy, sessions, caches, feature flags, test IDs, or other keys, test at least two distinct scopes when feasible, interleave calls across scopes, include a missing/default/no-context case when relevant, and assert each scope sees only its own data or behavior.
- For server/API endpoint additions or route/auth/status-code changes, prefer live HTTP validation with `curl`, HTTPie, or an equivalent CLI client. Exercise at least one success path and one relevant failure path for each changed route family. If live HTTP probing is not feasible, use the framework's in-process HTTP test client and state why that evidence is equivalent enough.
- For other server/API changes, run the app and call affected endpoints when feasible.
- For frontend changes, use Playwright/browser evidence when feasible.
- For bug fixes, compare before/after behavior when feasible.
- If end-to-end execution is blocked, report the exact blocker, gather the closest equivalent evidence, and clearly mark the residual risk.

The Findings section must preserve all concern classes with nested labels for `Must-fix findings`, `Non-blocking concerns / hardening`, and `Decisions needed`. Include the failure reason and suggested repair when failing; write `none` for each empty class.
The Candidate completeness and Behavioral evidence sections must include:
- Diff inspected: yes/no
- Candidate completeness checked: yes/no/not a git repo; required files tracked and untracked files explained
- Scope mapping checked when relevant: changed surfaces verified; protected surfaces preserved by zero-diff/sentinel check
- Requirement and consumer path identified: yes/no; include the real consumer path exercised or why not feasible
- Independent focused checks run: command + pass/fail
- Behavioral evidence gathered through the real consumer path: yes/no/not applicable; include result
- Setup/config/control-plane verified through downstream runtime behavior when relevant: yes/no/not applicable
- Isolation/scoping/leakage checked when relevant: yes/no/not applicable; include scopes and no/default-scope result
- New/changed HTTP endpoints probed by live HTTP or in-process HTTP client when relevant: yes/no/not applicable; include routes, headers, expected status, and actual status
- Source-only or internal-state-only verification used: yes/no; if yes, explain why sufficient or list residual risk

Use `none` for empty Findings, Residual risks, or Recommendation.

Task:
{{task}}

{{artifactGuidance}}

## DSM child prompt

Task:
{{task}}

Verification round: {{verifyRound}}/{{maxRepairRounds}}

{{artifactGuidance}}
