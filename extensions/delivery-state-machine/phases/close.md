---
phase: CLOSE
agent: delegate
model: global.anthropic.claude-haiku-4-5-20251001-v1:0
thinking: low
---

## Orchestrator instruction

Launch delegate with the configured lightweight model only if verification passed and review has no blockers.

## Child prompt

Close this delivery.

Task:
{{task}}

Instructions:
- Proceed only if final verification passed and final review has no blockers.
- Inspect repository instructions.
- Run fast CI-equivalent local verification for changed areas after the final code change.
- Before commit/MR, inspect candidate completeness with git status/diff. Do not close with required source, test, config, script, or doc files untracked or missing from the candidate diff.
- Commit only relevant files, push the branch, and create an MR/PR when applicable.
- For non-repo or no-diff tasks, close without push/MR.
- Remote CI does not need to finish before close unless the user explicitly asks.
- Report MR/PR link, branch, commit, and checks; or explain why no MR/PR was needed.
- If no MR/PR is needed for a non-repo or no-diff task, treat close as PASS and explain why in the summary.

Before close, produce a close-readiness checklist:
- Local fast verification passed after the final code change: yes/no, command + result
- Code changed after that verification: yes/no
- Final candidate completeness checked: yes/no/not a git repo; required new files tracked and untracked files explained
- Smoke test handled for UI/API-visible changes: run/skipped/not applicable + reason
- Review/verification blockers unresolved: yes/no
- Worktree clean before/after commit: yes/no
- Branch pushed and MR/PR created when applicable: yes/no/not applicable + link or reason
- Remote CI status: informational only; do not wait for CI unless the user explicitly asks. If running, write "running, not waited for by design because local verification passed".

{{artifactGuidance}}
