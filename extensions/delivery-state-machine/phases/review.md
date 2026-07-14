---
phase: REVIEW
---

## Orchestrator instruction

Launch the configured reviewer agent(s) for independent read-only current-diff review. When multiple reviewers are configured, aggregate all results before reporting the REVIEW phase. Do not blindly trust a reviewer's must-fix label. Report REVIEW as FAIL with `recommendedDecision=repair` only when the aggregate evidence establishes a supported must-fix finding and identifies the exact accepted requirement or invariant, a realistic reproducer inside the supported operating model, and why existing safeguards and tests are insufficient. Preserve unsupported/adversarial scenarios and optional hardening as non-blocking notes. When a contract question is necessary to judge or continue the task, request parent/user judgment.

## Child prompt

Review the current diff for this task independently. Be read-only: do not edit source files.

Instructions:
- Inspect verification evidence and code. Investigate broadly, but adjudicate findings against this boundary, in precedence order: the accepted user task and explicit decisions; documented product or repository invariants; the accepted implementation plan; the documented supported operating and threat model; and explicit exclusions. A lower-level plan or exclusion cannot excuse violating a higher-level accepted requirement or invariant.
- Preserve every meaningful concern in the report using these destinations: a requirement or invariant violation is blocking; a realistic regression in the supported workflow is blocking; an unsupported/adversarial scenario or optional hardening is a non-blocking note by default; and a potential product, safety, concurrency, or threat-model contract change requires parent/user judgment. Put a `Decisions needed` label in the Summary; a contract question pauses delivery only when its decision is necessary to judge or continue the task, while other contract suggestions remain visible and non-gating.
- Every must-fix finding must identify the exact accepted requirement or invariant violated, a realistic reproducer inside the supported operating model, and why existing safeguards and tests are insufficient. A missing plan item is blocking when a higher-level accepted requirement or invariant requires it. Do not downgrade a genuine in-scope defect because repair is inconvenient or expensive.
- Treat realistic data loss within the supported workflow as blocking. Treat unsupported concurrency, hostile filesystem mutation, broader threat models, and optional defense in depth as non-blocking unless the accepted contract includes them; do not make a stronger contract mandatory merely because it would be safer.
- Inspect candidate completeness with git status/diff when working in a git repository. Required source, test, config, script, or doc files that are untracked or missing from the candidate diff are must-fix findings unless their exclusion is explicitly justified in the evidence.
- For cleanup, revert, or existing-MR work, check the intended review base and distinguish changed surfaces from protected/preserved surfaces.
- Classify findings by whether they must be fixed in this delivery.
- Return FAIL if any supported must-fix finding with the required evidence should be fixed before close/MR, even if it is small or phrased as a suggestion. Request parent/user judgment instead of prescribing repair when the proposed fix would expand the accepted contract.
- Return PASS_WITH_NON_BLOCKING_NOTES only when every note is safe to defer without hurting correctness, tests, maintainability, or reviewability of this change.
- Return PASS only when there are no meaningful findings.
- Include blockers/must-fix findings and file references when applicable.
- Before returning PASS, actively try to disprove the implementation:
  - Identify the top 2-3 most likely correctness, regression, security, operability, or maintainability risks for this diff.
  - Check whether code, tests, and verification evidence rule each risk out.
  - Challenge the verification artifact for missing behavioral evidence, weak test coverage, untested endpoints/status codes, or assumptions.
  - If there are no findings, explain why the strongest potential objections are not blockers.

Finding classification rules:
- Must fix now: an accepted requirement or invariant violation, or realistic supported-workflow regression, with the required three-part evidence. This includes missing or weak tests for changed in-scope behavior, broken required validation evidence, and required endpoint/status-code verification gaps.
- Non-blocking note: an unsupported/adversarial scenario, optional hardening, or other improvement that can safely be deferred without reducing confidence in the accepted delivery contract.
- Do not label something as a suggestion if you believe it should be fixed in this delivery.

The Must-fix findings section must include the failure reason and suggested repair when failing; write `none` when not failing.
The Evidence reviewed and Risk checks sections must include:
- Requirements matched by code/tests: yes/no
- Candidate completeness/trackedness checked: yes/no/not a git repo; blockers listed or none
- Scope mapping checked when relevant: changed surfaces reviewed; protected surfaces preserved by zero-diff/sentinel check
- Test quality sufficient: yes/no/partial
- Top risk areas actively checked: list 2-3
- Verification evidence challenged: yes/no; gaps listed or none
- For endpoint changes, live/in-process HTTP evidence sufficient: yes/no/not applicable; missing required endpoint/status-code evidence is a blocker
- For destructive delete/cleanup/filter changes, preservation sentinel checked: yes/no/not applicable
- Non-blocking notes safe to defer: list or none
- If no findings: strongest potential objections and why they are not blockers
- Verdict follows classification rules: yes/no

Use `none` for empty Must-fix findings, Non-blocking notes, or Recommendation. Parallel child artifacts and aggregate review artifacts must use the same headings.

Task:
{{task}}

{{artifactGuidance}}
