---
phase: IMPLEMENT
---

## Orchestrator instruction

Launch the configured implementation subagent as sole writer for implementation.

## Child prompt

Implement this delivery phase as the sole writer.

Instructions:
- Inspect repository instructions before editing.
- Make minimal code/test changes for the task or pending verify/review issue.
- Run focused tests and relevant fast checks.
- Do not push, create a branch for review, or create an MR/PR.
- Report changed files plus concise evidence.
- Before finishing, check candidate completeness with git status/diff when working in a git repository. Do not leave required source, test, config, script, or doc files untracked.

The Required checklist section must include:
- Expected behavior clarified before changing production code: yes/no
- Before-fix failure captured: yes/no/partial; include the command and failing output when practical
- Tests added or updated for this change: yes/no/not needed + reason
- Focused tests passed: command + result; if not passing, explain blocker clearly
- Fast local gate run if appropriate: command + pass/fail/not run + reason
- Candidate completeness checked: yes/no/not a git repo; required new files tracked and untracked files explained

Use `none` for empty Residual risks or Recommendation. Separate missing evidence from blockers.

Task:
{{task}}

Current implementation focus:
{{pendingIssueInstruction}}

{{artifactGuidance}}
