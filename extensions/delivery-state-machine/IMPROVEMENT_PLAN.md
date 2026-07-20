# Delivery State Machine Improvement Plan

## Objective

Make the delivery state machine enforce its workflow contract reliably, produce trustworthy artifacts and reports, and become easier to understand and maintain.

Correctness comes before broad refactoring. The persisted state shape, legacy restoration behavior, tool names, and delivery report schema v2 remain compatible during the initial work.

## Current status

- The bounded-review prerequisite merged in PR #36.
- Stages 0–1 established the post-prerequisite baseline and regression inventory.
- Stages 2–3 shipped together in PR #37. The atomic report pipeline and strict artifact contracts pass the focused and full verification suites; the PR records an independent reviewer PASS after two repair rounds.
- Stage 4 shipped exact pi-subagents child-usage attribution and immutable reporting in PR #39.
- Stage 5 shipped trusted runtime configuration, CLOSE guarding, retro extraction, atomic summary handling, and standard Pi truncation in PR #40.
- Stage 6 packaged dedicated delivery agents and separated static agent policy from dynamic child context. Focused/full verification, two frozen-candidate isolated-host smoke runs, and the independent review gate passed after two repair rounds.
- The standalone prerequisite in [`AGENT_EVAL_PLAN.md`](AGENT_EVAL_PLAN.md) shipped in PR #44. Its Stage 7 prerequisite-gate follow-up passed offline/full verification and the real-Pi canary, repaired authoritative runtime-identity and retained-evidence review findings, and cleared independent bounded review.
- Stage 7's simplified/frozen DSM benchmark completed: the pilot passed 20/20 and the full comparison passed 60/60 at one candidate commit; independent review returned `PASS_WITH_NON_BLOCKING_NOTES`. The dated report is [`benchmarks/agent-quality/reports/2026-07-20-stage7-agent-comparison.md`](benchmarks/agent-quality/reports/2026-07-20-stage7-agent-comparison.md). Stage 7 awaits the explicit delivery-default and namespace decisions; Stage 8 remains blocked until they are recorded.

## Recommended contract decisions

This plan assumes the following behavior:

1. Wrong-phase, duplicate, missing-verdict, and phase-invalid reports are rejected without changing state or files.
2. `IMPLEMENT: FAIL` enters `WAITING_DECISION` and never advances to `VERIFY`.
3. The user-facing decision set is reduced to `repair`, `accept_risk`, and `stop`; legacy `continue` and `defer` inputs remain parseable for persisted/API compatibility but are not offered in prompts or recommended by the workflow.
4. `repair` explicitly authorizes one additional complete repair cycle when any required IMPLEMENT, VERIFY, or REVIEW budget is exhausted. The machine extends only the required limits, preserves counters/history, and records the user-authorized extension instead of resetting the delivery.
5. `accept_risk` is the only decision that bypasses a failed gate, and it records the accepted risk; `stop` terminates the delivery.
6. New phase reports require local artifact files at their exact planned paths. External MR/PR URLs belong inside the `CLOSE` artifact.
7. New artifacts must start with `RESULT: ...`; legacy artifact reading remains permissive.
8. Parallel execution is supported only for `VERIFY` and `REVIEW`. `IMPLEMENT` remains single-writer, while `CLOSE` remains single-closer.
9. A parent aggregate verdict may be more conservative than child verdicts, but never more optimistic.
10. Phase artifact or aggregate write failures block the report. Derived summary-report write failures produce a warning but do not reverse an otherwise completed transition.
11. Persisted state compatibility and `delivery-report.json` schema version 2 are preserved during this work.
12. New child usage comes from a version-tolerant pi-subagents adapter, not caller-supplied usage deltas or parent-session boundary estimates.
13. The adapter sums every incurred model attempt for one uniquely identified child. Parallel children are identified by child-specific metadata, transcript path/index, and exact planned artifact evidence; a shared run ID alone is insufficient.
14. Delivery total is the current session total minus the delivery-start baseline. Parent/orchestrator overhead is delivery total minus uniquely resolved delivery-child usage, without double-counting aggregate rows.
15. Missing, ambiguous, corrupt, or contradictory child metadata produces explicit unavailable/mismatch evidence; it is never replaced with guessed phase usage and does not change workflow verdicts.
16. Existing usage fields and legacy reports remain readable. `usageDelta` stays parseable for tool-schema compatibility but is deprecated, is not requested by prompts, and never overrides exact adapter data.
17. Delivery phase roles are package-scoped pi-subagents named `dsm.implementer`, `dsm.verifier`, `dsm.reviewer`, `dsm.closer`, and `dsm.retrospective`; the short `dsm` namespace is independent of the npm package name and avoids builtin-name collisions.
18. Static role policy, methodology, and tool restrictions belong in each agent system prompt. Child prompts retain only dynamic task/state data and the small runtime-owned artifact/verdict contract needed to prevent prompt/runtime drift.
19. Builtin names are not shadowed by default. Any later shadowing requires Stage 7 evidence across delivery and general-purpose scenarios and an explicit promotion decision.
20. Promptfoo `0.121.19` is the standalone eval-prerequisite orchestrator, pinned as an exact npm development dependency with the generated `package-lock.json` committed. Repository-owned TypeScript code remains authoritative for Pi launch behavior, disposable Git fixtures, deterministic scoring, and result normalization; Promptfoo must call the actual Pi/pi-subagents boundary through a custom provider rather than substitute another coding-agent SDK.
21. Deterministic workspace, Git, test, artifact, verdict, and mutation checks decide safety and correctness. Model-graded rubrics may supplement evidence-quality scoring but cannot override a deterministic critical failure or independently justify adoption.
22. Raw transcripts and per-run workspaces remain uncommitted. Committed reports record framework version, candidate commit, fixture hash, provider/model, thinking, context, effective tools, repetition, usage, scorer results, and infrastructure status so future reruns remain interpretable.

The bounded-review prerequisite in `REVIEW_SCOPE_PLAN.md` and Stages 0–6 are complete. Execute `AGENT_EVAL_PLAN.md` from a dedicated latest-`main` worktree before Stage 7. Stage 7 owns the model-backed agent comparison and adoption decision, and Stage 8 owns modularization.

## Scope boundaries

### In scope

- Phase and verdict validation
- Atomic report processing
- Repair-budget enforcement and explicit user-authorized budget extension
- Simplified user-facing decision semantics with compatibility handling for legacy decisions
- Single and parallel artifact contracts
- Trusted project configuration
- CLOSE command guard correctness
- Retro summary extraction
- Tool output truncation
- Package-scoped `dsm.*` delivery agents and static/dynamic prompt separation
- A pinned Promptfoo integration with repository-owned Pi launch, fixture-isolation, deterministic-scoring, and result-normalization boundaries
- Reproducible quality comparison against relevant pi-subagents builtins
- Behavior-preserving modularization of `index.ts`
- Focused, integration, persistence, and report-viewer tests
- Exact pi-subagents child-usage resolution behind a version-tolerant adapter
- Parent/orchestrator overhead derived without phase-boundary estimation
- Immutable usage-summary rendering
- Shared `session-usage` normalization needed by the adapter, with existing `/session-usage-all` behavior preserved

### Out of scope

- Removing `history` or other legacy persisted fields
- Delivery report schema v3
- Repricing provider usage or inventing missing token/cost data
- Making usage availability a workflow correctness gate
- General pi-subagents metadata redesign outside the delivery adapter
- Treating shell-command detection as a security sandbox
- Project-local phase prompt or launch-profile overrides
- Automatically shadowing general-purpose pi-subagents builtins without the Stage 7 promotion gate
- Broad report-viewer UI changes

## Stage 0 — Isolated baseline and compatibility inventory

- **Depends on:** latest `main` and a dedicated, clean implementation worktree.
- **Produces:** recorded baseline command evidence and `COMPATIBILITY_BASELINE.md`; no production behavior changes.
- **Done when:** `npm run verify` passes, the pre-change worktree is clean, and every compatibility-sensitive surface below is inventoried.

Before implementation:

1. Create a dedicated worktree from latest `main`.
2. Run:

   ```bash
   npm run verify
   git status --short
   ```

3. Record compatibility expectations for:
   - registered command and tool names;
   - tool parameter schemas;
   - `details.state` and `details.next` shapes;
   - planned step IDs and artifact filenames;
   - custom entry type `delivery-state-machine`;
   - history-only session restoration;
   - report JSON schema v2;
   - Markdown summary structure;
   - pinned launch-profile behavior.

### Expected files

- `extensions/delivery-state-machine/COMPATIBILITY_BASELINE.md`
- `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts`
- `shared/delivery-report.ts`
- `docs/delivery-report-schema-v2.md`

### Stop rule

Do not continue if the baseline suite fails or the implementation worktree is not clean.

## Stage 1 — Add failing regression tests

- **Depends on:** completed Stage 0 baseline and compatibility inventory.
- **Produces:** focused transition, parallel-round, artifact, and persistence regression tests that fail only for the intended correctness gaps.
- **Done when:** each confirmed issue has an expected failing test, existing acceptance expectations are not weakened, and production code remains zero-diff from the Stage 0 base.

Add tests that reproduce every confirmed correctness issue before changing production behavior.

### Transition tests

- Wrong phase cannot be reported.
- Duplicate phase report is rejected.
- Reports in `WAITING_DECISION`, `DONE`, or `STOPPED` are rejected.
- Missing verdict is rejected.
- Every invalid phase/verdict combination is rejected.
- `IMPLEMENT: FAIL` does not advance.
- `RETRO` accepts only `DONE`.
- Rejected reports leave phase, history, steps, counters, pending issue, accepted risks, and files unchanged.

### Review-scope, parallel, and round tests

- Prompt contracts preserve all four concern destinations: blocking requirement/invariant violations, blocking supported-workflow regressions, non-blocking unsupported/adversarial hardening, and parent/user contract decisions.
- Every must-fix finding requires a cited accepted requirement/invariant, realistic supported-model reproducer, and safeguard/test gap.
- Unsupported concurrency and hostile external mutation remain non-blocking unless the accepted contract includes them; supported-workflow destructive data loss remains blocking.
- Contract expansion requests parent/user judgment rather than automatic repair, while genuine in-scope failures still auto-route with `recommendedDecision=repair`.
- Subagent launch exhaustion cannot become synthetic PASS, silent parent self-verification, or an unacknowledged fallback.
- Child `FAIL` plus parent `PASS` is rejected.
- Child `PASS_WITH_NON_BLOCKING_NOTES` plus REVIEW `PASS` is rejected.
- A parent may conservatively report `FAIL` when all children pass.
- Review repair cannot schedule a VERIFY attempt beyond its limit.
- Automatic repair works at `maxRounds - 1` and waits for a user decision at exhaustion.
- User-selected `repair` at exhaustion authorizes exactly one additional complete repair cycle, extends only required phase limits, preserves attempt counters/history, and records the authorization.
- Repeated exhausted repairs require a new explicit user authorization; non-repair decisions never extend budgets.
- User-facing prompts offer only `repair`, `accept_risk`, and `stop`.
- Legacy `continue` and `defer` tool inputs follow their documented compatibility mapping without appearing in prompts.
- Parallel IMPLEMENT and CLOSE launch configurations are rejected.

### Artifact tests

- Single-child `details.next` contains exact `artifact`, `output`, and `outputMode` values.
- Missing, empty, directory, wrong-path, wrong-verdict, malformed, traversal, and symlink-escape artifacts are rejected.
- Alternate and semicolon-separated artifact paths are rejected.
- Every local artifact linked from Markdown or JSON exists.
- Stale aggregate artifacts cannot be reused.
- Rejected reports do not create aggregate files.

### Persistence tests

Improve the fake harness so `appendEntry()` records entries and restoration can be exercised. Cover:

- custom-entry round trip;
- tool-result round trip;
- legacy state without `steps`;
- legacy state without `maxPhaseRounds`;
- state without profile or usage fields;
- legacy backfilled usage surviving reconstruction.

### Implementation ownership

Stage 1 adds the complete regression set up front, but later stages make it pass in two explicit groups:

- **Stage 2-owned regressions:** phase/verdict transitions, aggregate-verdict dominance, round budgets, persistence restoration, and report atomicity, including proof that rejected reports do not create aggregate files.
- **Stage 3-owned regressions:** single-child output fields and the strict artifact path, file type, containment, symlink, content, heading, verdict, local-link, stale-aggregate, and atomic aggregate-write contracts.

Stage 3-owned regressions remain expected failures after Stage 2. They are not part of the Stage 2 completion gate.

### Stop rule

Production code must not change until the intentional regression tests fail for the expected reasons. Existing tests may be updated to create required artifacts, but corrected acceptance expectations must not be weakened to preserve broken behavior.

## Stage 2 — Implement an atomic report pipeline

- **Depends on:** Stage 1's intentional regression failures.
- **Produces:** a workflow-atomic validation, transition, persistence, and report-generation pipeline with schema-v2-compatible state and reports.
- **Done when:** all Stage 2-owned regressions pass, Stage 3-owned artifact-contract regressions remain documented expected failures, rejected reports are observationally inert, and the workflow-atomicity review gate below has no blocker.

Fix critical behavior in `index.ts` before broad module extraction.

Stage 2 owns workflow atomicity: validation and candidate-state calculation precede existing-compatible phase writes, and live state is replaced only after required writes succeed. Stage 3 owns strict exact-path validation and filesystem-atomic artifact/aggregate replacement using unique temporary files.

Use this processing order:

```text
validate input
→ inspect artifacts with existing compatibility rules
→ derive canonical report and minimum verdict
→ calculate transition on cloned state
→ prepare required phase writes
→ perform required phase writes with existing mechanics
→ replace live state
→ persist
→ render from an immutable snapshot
```

### Required behavior

- Require an active runnable phase.
- Require the reported phase to equal the current phase.
- Validate against one centralized phase/verdict matrix.
- Inspect artifact evidence with the existing compatibility behavior before mutating state; defer strict exact-path, containment, content, and filesystem-atomic write enforcement to Stage 3.
- Derive the minimum permissible aggregate verdict from child artifacts.
- Allow a parent verdict to be more conservative, never more optimistic.
- Apply usage backfill, step recording, history changes, and transition changes only to a cloned candidate state.
- Ensure rejected reports are observationally inert.
- Centralize all phase and repair-budget checks.
- Add `implement` to the pending-issue source union without changing the surrounding JSON shape or schema version.
- Make decision semantics explicit:
  - `repair`: return through `IMPLEMENT`; when a required budget is exhausted, explicit user selection authorizes one additional complete repair cycle by increasing only the necessary phase limits, without resetting attempts or delivery history;
  - `accept_risk`: record the unresolved issue and advance;
  - `stop`: terminate the delivery;
  - legacy `continue` and `defer`: retain a documented compatibility mapping for existing callers and persisted interactions, but do not expose them in user-facing decision prompts.
- Record every user-authorized budget extension in history with its affected phases and old/new limits.
- Never extend budgets for `accept_risk`, `stop`, clarification, or other non-repair feedback.
- Prohibit `accept_risk` from treating a failed implementation as a verified candidate.
- Require remaining IMPLEMENT, VERIFY, and REVIEW capacity for automatic repair; at exhaustion, enter `WAITING_DECISION` and make explicit `repair` capable of extending the complete required cycle.
- Route a code-changing CLOSE repair through IMPLEMENT → VERIFY → REVIEW.
- Make report generation consume an immutable post-transition snapshot. General summary/status usage backfill and rendering immutability are completed in Stage 4.

### Expected files

- `extensions/delivery-state-machine/index.ts`
- `extensions/delivery-state-machine/phase-config.ts`
- `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts`
- `shared/delivery-report.ts`
- `docs/delivery-report-schema-v2.md`

### Atomicity requirements

A rejected report must not:

- report a planned step;
- alter usage boundaries;
- reconcile or replace artifact paths;
- increment a phase attempt;
- append history;
- change the current phase;
- create or overwrite an aggregate artifact.

### Review gate

Require independent review of workflow transition atomicity, verdict dominance, budget boundaries, persistence compatibility, and the ordering of existing-compatible aggregate writes before live-state replacement. Apply the bounded-review rule under Mandatory review gates. Filesystem-atomic aggregate replacement is reviewed with Stage 3. Do not begin general modularization until this gate passes.

### Completion record

Completed in PR #37. The focused/full suites pass, rejected reports remain inert, report transitions render from cloned post-transition snapshots, and the PR records an independent reviewer PASS after two repair rounds. Stage 3 shipped in the same frozen candidate rather than remaining as expected failures after a separate Stage 2 merge; the combined review covered both stage contracts. Live-state mutation performed by summary/status usage backfill is explicitly carried into Stage 4.

## Stage 3 — Enforce exact artifact contracts

- **Depends on:** Stage 2 and its independent atomicity review gate.
- **Produces:** one phase-contract source of truth, strict validation for newly submitted artifacts, and valid VERIFY/REVIEW aggregate artifacts.
- **Done when:** all remaining Stage 3-owned regressions pass, including exact-path, containment, content, verdict, aggregate, and atomic-write tests, while completed and legacy artifacts remain readable.

Centralize phase artifact rules instead of spreading them across prompts, runtime strings, and tests.

A single source of truth should define, per phase:

- allowed verdicts;
- required headings;
- filename stem;
- whether parallel execution is allowed;
- aggregate-verdict precedence.

### Required changes

- Return top-level `artifact`, `output`, and `outputMode: "file-only"` for single-child phases.
- Put the exact attempt-specific artifact path in each child prompt.
- Require each artifact to:
  - match its planned path;
  - be a regular file;
  - stay inside the run artifact directory;
  - not escape through symlinks;
  - be non-empty;
  - begin with a phase-valid `RESULT` line;
  - contain required headings;
  - agree with the reported verdict.
- Apply the same validation to every parallel child.
- Generate valid phase-specific aggregate artifacts for VERIFY and REVIEW.
- Validate an existing aggregate artifact instead of trusting its path.
- Write generated artifacts atomically using unique temporary files and cleanup on failure.
- Remove alternate-path reconciliation and semicolon-separated child artifact handling.

### Compatibility boundary

Existing completed and legacy artifacts remain readable. Strict enforcement applies when submitting new phase reports.

### Completion record

Completed in PR #37. Exact-path, file-type, containment, symlink, content, heading, verdict, local-link, stale-aggregate, and atomic replacement regressions pass. The PR records the required independent review result; no Stage 3 blocker remains.

## Stage 4 — Exact subagent usage and immutable reporting

- **Depends on:** completed Stage 3 and the merged PR #37 candidate.
- **Produces:** a version-tolerant pi-subagents usage adapter, exact child-step usage where metadata is available, derived parent/orchestrator overhead, and summary rendering that never mutates workflow state.
- **Done when:** current and legacy metadata fixtures resolve deterministically, metadata totals match transcript evidence in validation fixtures, parallel children cannot be conflated or double-counted, unavailable data is explicit rather than estimated, and repeated status/summary rendering leaves persisted and in-memory workflow state unchanged.

### Adapter contract

Create one boundary that owns every pi-subagents-specific detail:

```text
pi-subagents metadata/transcript
  → child identity + normalized UsageTotals + validation status
  → delivery step usage
```

- Read current `modelAttempts[].usage` and sum every incurred model attempt for the child, including attempts before a successful fallback.
- Retain read compatibility for historical top-level `usage` metadata.
- Normalize provider fields through the shared token-total and cost policy instead of duplicating arithmetic.
- Use current async transcript `message_end` assistant usage as independent validation evidence in tests and as a fallback only when the complete child transcript is available.
- Match one delivery step to one child using exact planned artifact evidence plus child-specific metadata such as transcript path/index, agent, and timing. Never treat a shared parallel `runId` as a unique child identity.
- Reject ambiguous matches from attribution. Record `unavailable` or `mismatch` with a diagnostic reason instead of choosing the first candidate.
- Deduplicate by stable child identity before summing usage. Aggregate VERIFY/REVIEW rows never contribute child usage.

### Reporting policy

- Stop asking orchestrators to send `usageDelta`; retain the field only for tool-schema and persisted-data compatibility.
- Exact adapter data wins over legacy/manual values. Legacy values remain visible with their historical attribution label but do not override newly resolved exact usage.
- Remove phase-boundary estimation, ambiguous-boundary refresh, delayed CLOSE/RETRO backfill, and report-time live-state mutation for new reports.
- Calculate `deliveryTotal = currentSessionTotal - usageAtStart`.
- Calculate `parentOrchestratorOverhead = deliveryTotal - sum(uniqueResolvedDeliveryChildren)` with non-negative arithmetic and an explicit completeness status.
- If any planned child is unresolved, show child and overhead completeness as unavailable/partial rather than claiming an exact parent number.
- Render Markdown and JSON from cloned immutable snapshots. Calling `delivery_status`, `delivery_summary`, or final report rendering repeatedly must not alter state, timestamps, steps, or persisted entries.

### Compatibility and failure policy

- Preserve existing tool parameter schemas, state restoration, report schema v2, and historical usage rows.
- Usage resolution failure does not alter a phase verdict or block workflow progression.
- Do not make the delivery extension import pi-subagents runtime code. The adapter consumes documented/persisted artifacts so absence of the extension degrades to explicit unavailable usage.
- Document the supported metadata versions and the adapter's unavailable/mismatch behavior.

### Expected files

- `extensions/delivery-state-machine/index.ts`
- `extensions/delivery-state-machine/pi-subagents-usage.ts`
- `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts`
- `extensions/delivery-state-machine/tests/fixtures/usage/`
- `extensions/delivery-state-machine/README.md`
- `shared/session-usage.ts`
- `extensions/session-usage/tests/session-usage.test.ts`

### Review gate

Require an independent bounded review of metadata-version handling, per-child identity, fallback-attempt summation, parallel deduplication, parent-overhead arithmetic, unresolved/mismatch semantics, legacy compatibility, and proof that report rendering is immutable. Do not begin Stage 5 until this gate has no blocker.

## Stage 5 — Pi runtime reliability

- **Depends on:** Stage 4 and its exact-usage/immutability review gate.
- **Produces:** trusted configuration resolution, canonical CLOSE authorization, atomic summaries, canonical retro extraction, and bounded tool output.
- **Done when:** trust, guard-bypass, summary write-policy, retro, and truncation tests pass without intercepting unapproved human `user_bash` behavior.

### Trusted configuration

- Import and use Pi's `CONFIG_DIR_NAME`.
- Resolve the project root as `gitRoot ?? ctx.cwd`.
- Read project delivery configuration only when `ctx.isProjectTrusted()` is true.
- Keep global configuration and `PI_DELIVERY_ARTIFACT_ROOT` available regardless of project trust.
- Resolve delivery configuration once at start.
- Pass the resolved artifact root into artifact-directory creation instead of rereading project configuration.

### CLOSE guard

- Derive close authorization from canonical phase state rather than using `readyToClose` as an independent bypass.
- Clear or normalize stale readiness flags after failure, repair, restoration, and transition away from CLOSE.
- Fail closed for malformed restored state.
- Isolate command detection and test:
  - `git -C <repo> push`;
  - `env git push`;
  - `command git push`;
  - executable paths;
  - separators and newlines;
  - nested `sh -c` and `bash -c`.
- Document that this guard is defense in depth, not a security boundary.
- Do not intercept deliberate human `user_bash` commands unless that behavior is separately approved.

### Reporting and tool output

- Extract canonical `## Critical fixes` from retro artifacts.
- Retain the old longer heading as a read-compatibility fallback.
- Make Markdown and JSON summary writes atomic.
- Treat derived summary-write failures as warnings without reversing completed workflow transitions.
- Use Pi's truncation utilities and standard 50KB/2,000-line limits for tool content.
- Preserve complete structured `details` for compatibility.

### Review handoff

Stage 5 focused/full validation and an independent bounded runtime review must pass before Stage 6 starts. Stage 6 retains a combined integration review of the frozen runtime, packaged-agent discovery, prompt/tool policy, and real-host launch behavior.

### Expected files

- `extensions/delivery-state-machine/index.ts`
- `extensions/delivery-state-machine/README.md`
- `extensions/delivery-state-machine/phases/retro.md`
- `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts`

## Stage 6 — Package delivery agents and separate static prompts

- **Depends on:** Stage 5 runtime/configuration behavior and pi-subagents package-agent discovery through `pi.subagents.agents`.
- **Produces:** five package-owned `dsm.*` agents, concise dynamic child prompts, package-discovery tests, and isolated host-smoke evidence.
- **Done when:** an isolated Pi home with no user/project agent definitions discovers every `dsm.*` agent from this package, the delivery workflow launches each phase successfully through the non-default candidate profile, focused/full verification passes, and an independent review confirms prompt, tool, and runtime-contract alignment.

Expose `extensions/delivery-state-machine/agents/` by adding the supported `pi.subagents.agents` field to `package.json`. Define these logical package/runtime identities:

```text
dsm.implementer
dsm.verifier
dsm.reviewer
dsm.closer
dsm.retrospective
```

Use `package: dsm` plus the local role name in each agent frontmatter. The namespace is a logical pi-subagents identifier, not the npm package name. Do not use colon-separated names, unqualified builtin names, `/delivery-setup`, manual user-file copying, or unsupported `pi.agents` metadata.

### Prompt and tool ownership

Move stable role behavior into the agent system prompts:

- role and phase objective;
- hard safety and mutation rules;
- evidence-gathering methodology;
- finding/verdict discipline;
- stable artifact content expectations;
- supervisor-escalation behavior.

Keep dynamic and runtime-authoritative data in the generated child prompt:

- accepted user task and current pending issue;
- attempt/round and repair context;
- resolved project/worktree root;
- exact planned artifact path;
- allowed phase verdicts and the minimal artifact contract derived from `PHASE_CONTRACTS`.

Keep orchestrator-only launch/report instructions out of child agent prompts. Launch profiles remain authoritative for model, context, user-configurable phase selection, and explicit thinking overrides; stable bundled thinking defaults belong in agent frontmatter so parent model mediation does not need to relay them. Assign editing tools only where phase behavior requires them; VERIFY and REVIEW must not receive source-editing tools, and CLOSE/RETRO must not modify the candidate implementation. `bash` restrictions remain behavioral safeguards rather than a security sandbox.

Add contract tests that fail when an agent is missing, is not package-qualified, receives unsafe tools, or disagrees with `PHASE_CONTRACTS`. Preserve existing prompt/profile override compatibility. Stage 6 adds a non-default `dsm-candidate` launch profile and agent/profile-aware prompt materialization so DSM launches receive concise dynamic prompts while the current default profile retains its complete builtin-compatible prompts. Treat the candidate profile as unreleased evaluation configuration: do not change the bundled default or release/adopt DSM agents as delivery defaults before the Stage 7 adoption gate passes.

### Expected files

- `package.json`
- `extensions/delivery-state-machine/agents/*.md`
- `extensions/delivery-state-machine/phases/*.md`
- `extensions/delivery-state-machine/phase-launches.json`
- `extensions/delivery-state-machine/phase-config.ts`
- `extensions/delivery-state-machine/README.md`
- `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts`

### Migration and isolated verification

Do not depend on the developer's existing `~/.pi/agent/agents/fresh-verifier.md`. In an isolated Pi home:

1. load pi-subagents and this package;
2. prove all five agents have source `package` and the expected dotted runtime names;
3. launch each phase with its configured model/context and exact output path;
4. exercise a representative delivery through VERIFY, REVIEW, CLOSE, and RETRO;
5. confirm no user/project agent file supplied the roles.

Do not remove the user-scoped `fresh-verifier` in Stage 6 because the current default profile still depends on it. Remove it only after Stage 7 promotes the DSM candidate to the bundled default and a final default-profile smoke proves `dsm.verifier` is active; if the adoption gate fails or remains inconclusive, retain it. Session-spawn exhaustion still blocks the independent gate and requires a new Pi session rather than synthetic PASS or parent fallback.

### Completion record

Completed on 2026-07-18. The five package-scoped DSM agents own stable role, methodology, harness-discovery, escalation, and parent-reporting policy; generated DSM prompts are limited to dynamic task/state plus runtime-owned artifact, verdict, harness, and launch-path contracts only for the exact phase-owned agent identity, with regressions preserving complete prompts for cross-phase, arbitrary, default, and profile-override agents. The isolated-host smoke verifies every child's effective model against `DSM_SMOKE_MODEL` and requires authoritative `delivery-report.json` state to be `DONE`, with regressions for model mismatch and false sentinel signaling. Focused tests, `npm run verify`, `git diff --check`, and the model-backed isolated-host smoke pass. The independent review gate returned `PASS_WITH_NON_BLOCKING_NOTES` after two repair rounds; only a documentation wording follow-up remains non-blocking.

## Evaluation-framework prerequisite

Completed in PR #44 and its Stage 7 prerequisite-gate follow-up. [`AGENT_EVAL_PLAN.md`](AGENT_EVAL_PLAN.md) owns the Promptfoo integration, actual Pi runner, versioned contracts, disposable isolation, deterministic scorers, ten scenario fixtures, offline CI coverage, real-Pi canary, documentation, and independent review.

Work items W1–W4 and every prerequisite completion gate passed. Stage 7 consumes the resulting frozen, reviewed framework and ready-to-run scenario catalog; the prerequisite did not run the comparative benchmark or make an adoption decision.

## Stage 7 — Compare DSM agents with pi-subagents builtins

- **Depends on:** completed standalone `AGENT_EVAL_PLAN.md`, its independent framework review gate, and the frozen Stage 6 candidate.
- **Produces:** reviewed pilot/full benchmark evidence, a dated report, an explicit delivery-default decision, and a separate namespaced-versus-shadowing decision.
- **Consumes:** the prerequisite plan's frozen runner, schemas, scenarios, fixtures, isolation, scorers, and result semantics; affected pairs must be invalidated and rerun if any of those change.
- **Done when:** the 20-trial pilot and 60-trial full benchmark are complete, infrastructure reruns have joined, objective quality/safety/usage evidence passes independent review, and the user records the delivery-default decision.

Use the candidate pairs, ten scenarios, controls, and later-benchmark defaults prepared by `AGENT_EVAL_PLAN.md`. A supported safety or correctness regression blocks Stage 8 and routes prompt/tool repair back to Stage 6; infrastructure-limited evidence remains inconclusive. Keep `dsm.*` names unless a separate general-purpose evaluation and explicit user decision support builtin shadowing.

### Benchmark record

After the initial comparison, the five DSM system prompts were simplified to retain static phase policy while removing duplicated runtime-owned output contracts, and inherited skills were disabled to match the builtins. The frozen pilot `eval-p7B-2026-07-20T02:39:06` passed 20/20 and the full comparison `eval-Bqp-2026-07-20T03:18:34` passed 60/60 at commit `08cfb3d802cbb7cff4993f92105e97616663094c`. DSM and builtin quality remained tied; DSM child cost was approximately 26.5% higher and mean trial duration 7.4% longer. Independent review returned `PASS_WITH_NON_BLOCKING_NOTES`; the explicit promotion/namespace decisions remain pending in the [dated report](benchmarks/agent-quality/reports/2026-07-20-stage7-agent-comparison.md).

## Stage 8 — Modularize `index.ts`

- **Depends on:** Stage 7 and its reviewed quality report, with the packaged-agent contracts frozen and all corrected runtime behavior independently reviewed.
- **Produces:** behavior-preserving modules with the documented dependency direction and a thin Pi registration/orchestration façade.
- **Done when:** full validation passes with no import cycles, registration/API/schema-v2/report-viewer differences, or legacy reconstruction regressions.

Only begin this stage after the corrected implementation passes its independent review.

Extract one concern per commit:

```text
extensions/delivery-state-machine/
├── index.ts                    # Pi registration and orchestration façade
├── types.ts                    # leaf types only
├── state.ts                    # defaults, normalization, legacy restoration
├── workflow.ts                 # transitions, verdicts, decisions, budgets
├── artifact-contract.ts        # paths, validation, aggregation
├── delivery-config.ts          # trusted config and artifact-root resolution
├── pi-subagents-usage.ts       # external metadata adapter and exact child identity
├── usage.ts                    # delivery totals and parent-overhead derivation
├── journey-report.ts           # immutable Markdown/JSON generation
├── close-guard.ts              # authorization and command detection
├── phase-config.ts             # prompt/profile materialization
└── tests/
    ├── harness.ts
    ├── workflow.test.ts
    ├── artifacts.test.ts
    ├── config-guard.test.ts
    ├── usage.test.ts
    ├── reporting.test.ts
    └── integration.test.ts
```

Keep the existing test entry file as an aggregator so current package commands remain valid.

### Dependency direction

```text
types
  ↓
state / workflow / delivery-config / pi-subagents-usage
  ↓
artifact-contract / close-guard
pi-subagents-usage
  ↓
usage
  ↓
journey-report
  ↓
index
```

Reporting consumes immutable snapshots. Workflow policy must not depend on Pi UI or extension registration. Artifact validation and external usage adapters may read files but must not mutate workflow state.

### Additional safe cleanup

After extraction and parity validation:

- share `/deliver` and `delivery_start` initialization;
- remove unused `writeJourneyReport`;
- remove unused internal variables and prompt context fields;
- consolidate duplicate agent-directory resolution and slug helpers;
- clearly mark reserved CLOSE/RETRO round settings;
- reduce repeated orchestration instructions by making runtime contracts authoritative and linking documentation to them.

Do not remove persisted compatibility fields during this work.

### Refactor stop rule

Stop on any:

- schema-v2 difference;
- unexpected Markdown golden difference;
- legacy reconstruction regression;
- tool or command registration change;
- runtime import cycle;
- report-viewer failure.

## Parallelization

Top-level stages are sequential: each stage consumes the previous stage's evidence, and Stages 6–8 overlap compatibility-sensitive phase contracts, launch profiles, eval controls, tests, or `index.ts`. Keep one active writer and do not begin a later stage until the prior stage's completion and review gates pass.

Safe parallel work is limited to:

- read-only investigation and prompt/test-design review within Stage 6;
- independent verifier/reviewer passes against a frozen candidate diff;
- read-only Promptfoo/API research during the standalone eval prerequisite; framework, schema, fixture, scorer, and dependency-lock edits remain under one writer, and the real-Pi canary starts only after offline validation passes;
- Stage 7 benchmark trials after fixtures, scoring rules, model settings, and candidate revision are frozen, with each trial isolated in its own temporary repository/worktree;
- isolated smoke-test preparation that does not edit the active worktree.

The Stage 7 benchmark coordinator must join all trial artifacts into one report before the promotion decision. Do not parallelize production edits, shared benchmark-fixture edits, usage/report writes, persistence-shape changes, or Stage 8 extraction commits. Parallel reviewers must join into one finding set before the sole writer applies repairs, and the relevant mandatory gate must pass before work resumes.

## Validation checklist

After every stage:

```bash
NODE_PATH=${NODE_PATH:-$HOME/.pi/agent/npm/node_modules} \
  bun extensions/delivery-state-machine/tests/delivery-state-machine.test.ts

git diff --check
```

Before final review:

```bash
npm run test
npm run report-viewer:verify
npm run verify
git diff --check
git status --short
```

For the standalone eval-prerequisite commands and the prepared Stage 7 benchmark defaults, follow [`AGENT_EVAL_PLAN.md`](AGENT_EVAL_PLAN.md).

Perform a live Pi smoke test covering:

1. start a delivery;
2. reject an out-of-order report;
3. complete IMPLEMENT with an exact artifact;
4. fail VERIFY at exhausted budgets, choose `repair`, confirm one additional cycle is authorized and succeeds without resetting history;
5. confirm the decision prompt exposes only `repair`, `accept_risk`, and `stop`, then reject a contradictory parallel REVIEW;
6. confirm `delivery-report.json` gives each single and parallel child exactly one usage-bearing step equal to the sum of its pi-subagents model attempts, with no aggregate-step double count;
7. confirm delivery total and parent/orchestrator overhead satisfy the documented subtraction formula, then render status/summary twice and prove workflow state is unchanged;
8. reach CLOSE only after valid verification and review;
9. reconstruct state from the session;
10. open the generated structured report in report-viewer.

## Mandatory review gates

For every gate below, reviewers may investigate broadly but must adjudicate findings against the accepted stage scope, documented invariants, and supported operating model. Unsupported hardening is non-blocking; contract expansion requires parent/user judgment. Every must-fix finding must cite the violated requirement/invariant, a realistic supported-workflow reproducer, and the safeguard/test gap.

### After Stage 3

Apply the bounded-review rule above. Review:

- transition and report atomicity;
- verdict matrix and aggregate dominance;
- repair-budget boundaries;
- artifact path containment and completeness;
- legacy state and report compatibility.

### After Stage 4

Apply the bounded-review rule above. Review:

- current and legacy pi-subagents metadata handling;
- exact per-child identity and fallback-attempt summation;
- parallel deduplication and ambiguity handling;
- delivery-total and parent-overhead arithmetic;
- immutable status and summary rendering;
- schema-v2 and legacy usage compatibility.

### After Stage 6

Apply the bounded-review rule above. Review:

- package-agent discovery with no user/project agent dependency;
- `dsm.*` runtime identity and absence of builtin-name collisions;
- static system-prompt versus dynamic child-prompt ownership;
- per-phase tools, mutation restrictions, and fresh-context behavior;
- profile override, artifact-contract, and real-host launch compatibility;
- project trust, CLOSE guard, report-write policy, and truncation behavior retained from Stage 5.

### After the evaluation-framework prerequisite

Apply the bounded-review rule above to the completion criteria and stop rules in [`AGENT_EVAL_PLAN.md`](AGENT_EVAL_PLAN.md). Do not begin Stage 7 until work items W1–W4 and the independent framework gate pass.

### After Stage 7

Apply the bounded-review rule above to the Stage 7 benchmark evidence and adoption decision. Do not begin Stage 8 until the pilot/full results join, the independent gate passes, and the explicit user decision is recorded.

### After Stage 8

Apply the bounded-review rule above. Review:

- module dependency direction;
- absence of circular imports;
- registration/API parity;
- schema-v2 and report-viewer parity;
- removal of only genuinely dead internal code.

Any correctness, persistence, security, artifact-integrity, package-discovery, or schema blocker stops later stages and release.

## Execution checklist

- [x] **Stage 0:** create the dedicated worktree from fetched `origin/main`, run `npm run verify`, confirm the pre-change tracked baseline is clean, and record `COMPATIBILITY_BASELINE.md`.
- [x] **Stage 1:** add transition, decision-menu, user-authorized round-extension, artifact-integrity, and persistence regressions; capture the expected failures; confirm production files remain zero-diff.
- [x] **Stage 2:** ship and independently review the workflow-atomic report pipeline, decision contract, and explicit repair authorization in PR #37, with the general usage-rendering immutability follow-up assigned to Stage 4.
- [x] **Stage 3:** ship exact artifact contracts and filesystem-atomic aggregate replacement in PR #37; pass containment, completeness, compatibility, and mandatory review gates.
- [x] **Stage 4:** replace best-effort usage backfill with the version-tolerant pi-subagents adapter, exact per-child attribution, derived parent overhead, immutable reporting, focused/full validation, and the Stage 4 review gate.
- [x] **Stage 5:** implement trusted configuration, canonical CLOSE guarding, retro extraction, atomic summary policy, and standard truncation; pass focused/full runtime validation and the independent Stage 5 review gate.
- [x] **Stage 6:** package the five `dsm.*` agents, add a non-default candidate profile with static agent policy and concise dynamic prompts, preserve the current default and profile overrides, and pass clean-home candidate discovery/full delivery smoke plus focused/full validation and review.
- [x] **Evaluation-framework prerequisite:** execute work items W1–W4 in [`AGENT_EVAL_PLAN.md`](AGENT_EVAL_PLAN.md), including all ten scenario fixtures, offline/full verification, the opt-in real-Pi canary, and independent review without model calls in normal CI.
- [ ] **Stage 7:** freeze the prerequisite outputs, run the 20-trial pilot and 60-trial full paired benchmark, publish and independently review the report, record the explicit delivery-default and namespace decisions, and promote only on an approved PASS.
- [ ] **Stage 8:** extract modules one concern per commit after agent contracts are frozen, preserve dependency direction and compatibility, run the complete live smoke and final verification commands, and pass the final modularization review gate; stop release on any unresolved blocker.
