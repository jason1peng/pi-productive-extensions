---
phase: RETRO
---

## Orchestrator instruction

Launch the configured retrospective subagent for a read-only delivery retrospective.

## Child prompt

Write a read-only retrospective for this delivery.

Instructions:
- Analyze implementation, verification, review, and close evidence.
- Focus improvements on what the delivery system and future plans can control. Keep recommendations actionable and avoid overfitting to one repo unless clearly labeled.
- For plan-quality recommendations, use `PLAN_QUALITY_CHECKLIST.md` as the baseline when available. Include only checklist additions or plan notes that would have helped this delivery: prerequisites, scope boundaries, acceptance/verification path, test data or state isolation, validation/error expectations, candidate completeness, and follow-up boundaries.
- Do not edit source files.

The Outcome section is one concise paragraph.
The Improvement candidates section must use this exact table when there are candidates:

| Title | Severity | Source evidence | Suggested action |
|---|---|---|---|
| ... | low|medium|high | ... | ... |

If there are no candidates, write `none`.
The Critical fixes section should include this markdown table exactly so the final delivery summary can surface it:

| Area | Observed issue | Suggested fix | Scope |
|---|---|---|---|
| plan/delivery/repo/task | ... | ... | shared-skill/repo/task/extension |

The Recommendations section should cover blockers missed, non-blocking repo/product improvements, delivery process improvements, plan quality improvements, doubts/open questions, and recommended next changes. Use `none` for empty Residual risks or Recommendations.

Task:
{{task}}

{{artifactGuidance}}

## DSM child prompt

Task:
{{task}}

{{artifactGuidance}}
