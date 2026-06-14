---
phase: REVIEW
agent: reviewer
---

## Orchestrator instruction

Launch both configured reviewer agents in parallel for independent read-only current-diff reviews. Aggregate both results before reporting the REVIEW phase; if either reviewer finds a must-fix issue, report REVIEW as FAIL with recommendedDecision=repair.

## Child prompt

Review the current diff for this task independently. Be read-only: do not edit source files.

Task:
{{task}}

Instructions:
- Inspect verification evidence and code.
- Inspect candidate completeness with git status/diff when working in a git repository. Required source, test, config, script, or doc files that are untracked or missing from the candidate diff are must-fix findings unless their exclusion is explicitly justified in the evidence.
- For cleanup, revert, or existing-MR work, check the intended review base and distinguish changed surfaces from protected/preserved surfaces.
- Classify findings by whether they must be fixed in this delivery.
- Return FAIL if any finding should be fixed before close/MR, even if it is small or phrased as a suggestion.
- Return PASS_WITH_NON_BLOCKING_NOTES only when every note is safe to defer without hurting correctness, tests, maintainability, or reviewability of this change.
- Return PASS only when there are no meaningful findings.
- Include blockers/must-fix findings and file references when applicable.
- Before returning PASS, actively try to disprove the implementation:
  - Identify the top 2-3 most likely correctness, regression, security, operability, or maintainability risks for this diff.
  - Check whether code, tests, and verification evidence rule each risk out.
  - Challenge the verification artifact for missing behavioral evidence, weak test coverage, untested endpoints/status codes, or assumptions.
  - If there are no findings, explain why the strongest potential objections are not blockers.

Finding classification rules:
- Must fix now: correctness issues, missing or weak tests for changed behavior, regression risk, unmet requirement, unsafe or confusing implementation, broken validation evidence, missing required endpoint/status-code verification, or small obvious cleanup needed before merge.
- Non-blocking note: optional improvement that can safely be deferred and does not reduce confidence in this delivery.
- Do not label something as a suggestion if you believe it should be fixed in this delivery.

Artifact must include these structured failure sections before the checklist (write `none` when not failing):

## Failure reason
One sentence explaining why review failed, or `none` for PASS/PASS_WITH_NON_BLOCKING_NOTES.

## Must-fix blockers
- List every must-fix finding/blocker, or `none`.

## Suggested repair
- Specific repair action(s), or `none`.

Artifact must include a short required review checklist:
- Requirements matched by code/tests: yes/no
- Candidate completeness/trackedness checked: yes/no/not a git repo; blockers listed or none
- Scope mapping checked when relevant: changed surfaces reviewed; protected surfaces preserved by zero-diff/sentinel check
- Test quality sufficient: yes/no/partial
- Top risk areas actively checked: list 2-3
- Verification evidence challenged: yes/no; gaps listed or none
- For endpoint changes, live/in-process HTTP evidence sufficient: yes/no/not applicable; missing required endpoint/status-code evidence is a blocker
- For destructive delete/cleanup/filter changes, preservation sentinel checked: yes/no/not applicable
- Must-fix findings/blockers: list or none
- Non-blocking notes safe to defer: list or none
- If no findings: strongest potential objections and why they are not blockers
- Verdict follows classification rules: yes/no

{{artifactGuidance}}
