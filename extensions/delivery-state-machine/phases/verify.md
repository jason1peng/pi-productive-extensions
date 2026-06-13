---
phase: VERIFY
agent: fresh-verifier
model: openai/gpt-5.5
thinking: low
context: fresh
---

## Orchestrator instruction

Launch fresh-verifier in fresh context for verification round {{verifyRound}}/{{maxRepairRounds}}.

## Child prompt

Independently verify this task. Be read-only: do not edit source files.

Task:
{{task}}

Instructions:
- Verify behavior independently against the requirements and candidate diff.
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

Artifact must include a short required verification checklist:
- Diff inspected: yes/no
- Candidate completeness checked: yes/no/not a git repo; required files tracked and untracked files explained
- Scope mapping checked when relevant: changed surfaces verified; protected surfaces preserved by zero-diff/sentinel check
- Requirement and consumer path identified: yes/no; include path or why not applicable
- Independent focused checks run: command + pass/fail
- Behavioral evidence gathered through the real consumer path: yes/no/not applicable; include result
- Setup/config/control-plane verified through downstream runtime behavior when relevant: yes/no/not applicable
- Isolation/scoping/leakage checked when relevant: yes/no/not applicable; include scopes and no/default-scope result
- New/changed HTTP endpoints probed by live HTTP or in-process HTTP client when relevant: yes/no/not applicable; include routes, headers, expected status, and actual status
- Source-only or internal-state-only verification used: yes/no; if yes, explain why sufficient or list residual risk
- Blockers: list or none
- Non-blocking notes: list or none

{{artifactGuidance}}
