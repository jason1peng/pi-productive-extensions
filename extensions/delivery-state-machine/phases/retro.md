---
phase: RETRO
agent: delegate
thinking: high
---

## Orchestrator instruction

Launch delegate for a read-only delivery retrospective.

## Child prompt

Write a read-only retrospective for this delivery.

Task:
{{task}}

Instructions:
- Analyze implementation, verification, review, and close evidence.
- Focus improvements on what the delivery system and future plans can control. Keep recommendations actionable and avoid overfitting to one repo unless clearly labeled.
- For plan-quality recommendations, use `PLAN_QUALITY_CHECKLIST.md` as the baseline when available. Include only checklist additions or plan notes that would have helped this delivery: prerequisites, scope boundaries, acceptance/verification path, test data or state isolation, validation/error expectations, candidate completeness, and follow-up boundaries.
- Do not edit source files.

Write the retrospective for quick human scanning:
- Outcome: one paragraph
- Include this markdown table exactly so the final delivery summary can surface it:

## Critical fixes for future plans / delivery

| Area | Observed issue | Suggested fix | Scope |
|---|---|---|---|
| plan/delivery/repo/task | ... | ... | shared-skill/repo/task/extension |

- Blockers missed: list or none
- Non-blocking repo/product improvements: prioritized list, separate from process changes
- Actionable delivery process improvements: for each item include target prompt/process, exact change, and acceptance check
- Actionable plan quality improvements: for each item include the future-plan checklist addition, when it applies, and an example if useful
- Doubts/open questions: explicit list
- Recommended next changes: concrete, small, and ordered

{{artifactGuidance}}
