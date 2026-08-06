# Delivery summary output

The state machine writes `00-delivery-summary.md` as a Markdown projection of the unchanged delivery state and phase artifacts. The projection is intentionally verdict-first:

1. `## Outcome` — status, target, branch, known merge-request/commit references, repair rounds, cost, pending decisions, and a one-line result.
2. Failure/repair narrative and the slim `## Journey` table — phase, attempt, verdict, and artifact link only.
3. `## Appendix` — the complete prepared task, artifact directory and working directory, usage totals, attribution notes, phase counts, and step accounting (including agent/model/per-step usage).

The appendix preserves audit detail without putting machine paths or telemetry ahead of the outcome. Retro critical-fix content is emitted once in the main narrative and names its retro artifact; the Journey table owns the artifact link rather than copying it into another section. Missing usage is rendered as `unavailable`; a numeric zero is emitted only when usage-bearing evidence measured zero. Narrative cells are complete sentences, and a failure with no usable narrative is omitted rather than represented by a placeholder.

The structured `delivery-report.json` schema and phase/artifact contracts are unchanged. Legacy Markdown-only runs remain a viewer concern and continue to load through the report viewer's fallback path.
