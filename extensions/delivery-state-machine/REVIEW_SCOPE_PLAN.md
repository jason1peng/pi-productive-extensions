# Delivery Review Scope Prerequisite Plan

## Objective and ordering

Prevent delivery verification and review from silently expanding an accepted task, operating model, threat model, or safety contract while preserving broad risk discovery and strict blocking for genuine in-scope defects.

Deliver this as **one cohesive merge request** and merge it before continuing `IMPROVEMENT_PLAN.md`. The later improvement work and its mandatory review gates must start from the bounded review behavior established here.

After this prerequisite merges, continue the improvement plan from a new worktree based on updated `main` and rerun its Stage 0 baseline. Update `COMPATIBILITY_BASELINE.md` only where this prerequisite changes recorded expectations.

## Behavioral contract

Verification and review may investigate broadly, but findings are adjudicated against this precedence:

1. accepted user task and explicit decisions;
2. documented product or repository invariants;
3. accepted implementation plan;
4. documented supported operating and threat model;
5. explicit exclusions.

The plan does not excuse a violation of a higher-level task requirement or documented invariant. Conversely, a reviewer cannot make a stronger operating or threat model mandatory merely because it would be safer.

Reports preserve every meaningful concern using these destinations:

1. **Requirement or invariant violation** — blocking.
2. **Realistic regression in the supported workflow** — blocking.
3. **Unsupported/adversarial scenario or optional hardening** — non-blocking note by default.
4. **Potential product, safety, concurrency, or threat-model contract change** — parent/user judgment; it pauses the current delivery only when the decision is required to judge or continue the task.

Every must-fix finding must identify:

- the exact accepted requirement or invariant violated;
- a realistic reproducer inside the supported operating model;
- why existing safeguards and tests are insufficient.

“Actively disprove” means aggressively challenging correctness within this boundary. It does not authorize expanding the product contract.

For destructive behavior, realistic data loss within the supported workflow remains blocking. Defense against arbitrary concurrent external Git or filesystem mutation is non-blocking unless the accepted task or documented operating model requires it.

## Relationship to `IMPROVEMENT_PLAN.md`

This prerequisite is not a replacement for the broader improvement plan and must not take ownership of its architecture work.

- Add this plan’s scope regressions to the durable Stage 1 regression inventory.
- Stage 2 continues to own atomic report processing, transition validation, verdict handling, and repair-budget behavior.
- Stage 3 continues to own structured artifact validation and centralized phase contracts.
- Stage 6 continues to own modularization.
- Amend every mandatory review gate with this rule:

  > Reviewers may investigate broadly but must adjudicate findings against the accepted stage scope, documented invariants, and supported operating model. Unsupported hardening is non-blocking; contract expansion requires parent/user judgment.

The improvement plan’s references to remaining IMPLEMENT, VERIFY, and REVIEW capacity concern configured phase-round budgets. They do not imply access to pi-subagents’ private session-wide spawn counter.

## Scope boundaries

### In scope

- Built-in VERIFY and REVIEW prompts.
- Parent/orchestrator aggregation and repair guidance.
- Focused prompt-contract and existing transition-path regressions.
- Delivery-state-machine README guidance.
- Alignment of `IMPROVEMENT_PLAN.md` and its mandatory review gates.
- Explicit handling of subagent launch exhaustion: it must never become a synthetic PASS or unacknowledged parent fallback.

### Out of scope

- A new finding schema or delivery-report schema version.
- Natural-language scope inference in the state machine.
- New verdicts or state-machine phases.
- Proactive pi-subagents quota reservation or approximate spawn accounting.
- Atomic report-pipeline, artifact-contract, or modularization work already owned by `IMPROVEMENT_PLAN.md`.
- Changes to the Git cleanup implementation from PR #34.
- Changes in `/Users/jpeng/ai/pi-productive-extensions-git-cleanup-primary`; that worktree is read-only evidence.

### Compatibility requirements

- Preserve existing phase order, round limits, verdicts, state shape, tool schemas, and report schema v2.
- Preserve automatic repair for genuine in-scope VERIFY/REVIEW failures reported with `recommendedDecision=repair`.
- Preserve user/global prompt override behavior.
- Keep unsupported and optional concerns visible rather than suppressing them.

## Change

Perform this as one test-first implementation unit in a dedicated worktree created from freshly fetched `origin/main`; do not branch from the planning branch.

### Regression coverage

Add tests proving:

- an in-scope correctness or destructive-data-loss defect remains blocking and can route to IMPLEMENT with `recommendedDecision=repair`;
- unsupported concurrency is required to be reported as a non-blocking hardening concern unless the accepted contract includes it;
- a proposed contract expansion is required to request parent/user judgment rather than automatic repair;
- reviewer FAIL guidance requires a cited requirement/invariant, supported-workflow reproducer, and safeguard/test gap;
- all concern classes remain represented in phase reports;
- subagent launch exhaustion cannot be converted into PASS or silent parent self-verification.

Use existing transition tests for runtime routing behavior. Prompt-contract assertions are appropriate for semantic distinctions the state machine cannot infer from arbitrary prose. Capture the intended regression failures before changing production prompts.

### Verification and review prompts

Update `phases/verify.md` and `phases/review.md` to:

- define the accepted task, documented invariants, plan, supported model, and exclusions as the adjudication boundary;
- preserve must-fix findings, non-blocking concerns/hardening, and decisions needed;
- require the three-part evidence basis for every must-fix finding;
- state that a missing plan item is blocking when a higher-level accepted requirement or invariant requires it;
- state that unsupported concurrency, hostile filesystem mutation, and broader threat models default to non-blocking;
- distinguish realistic supported-workflow data loss from optional defense in depth;
- keep existing top-level artifact headings compatible, using nested labels or checklist fields rather than introducing a new artifact schema.

### Parent aggregation and repair guidance

Update `prompts/deliver.md` and only the minimal matching hardcoded guidance in `index.ts` when required for consistency:

- auto-repair only a supported must-fix finding with the required evidence;
- do not blindly trust a verdict label when its evidence contradicts its classification;
- preserve unsupported/adversarial scenarios and optional hardening as non-blocking notes;
- ask the user before adopting a new product, safety, concurrency, or threat-model contract;
- keep non-gating contract suggestions visible without pausing delivery;
- ask for a decision before reporting or repairing when a contract question is necessary to judge or continue the task;
- never downgrade a genuine in-scope defect because it is inconvenient or expensive;
- if pi-subagents reports spawn exhaustion, do not report PASS or substitute parent self-verification for a required independent gate; state that a new Pi session is required.

Do not add state, verdict, schema, or spawn-accounting mechanisms.

### Documentation alignment

Update `README.md` and `IMPROVEMENT_PLAN.md` to:

- document broad discovery versus narrow blocking and all four concern destinations;
- document the must-fix evidence requirement and contract-decision behavior;
- add the regressions to Stage 1;
- apply the bounded-review rule to future mandatory review gates;
- retain existing stage ownership;
- record that precise session-spawn reservation is deferred until pi-subagents exposes a reliable capacity interface.

Keep one concise durable explanation and reference it rather than creating competing contracts.

## Completion evidence

Run the baseline before implementation, then rerun all checks after the final change:

```bash
NODE_PATH=${NODE_PATH:-$HOME/.pi/agent/npm/node_modules} \
  bun extensions/delivery-state-machine/tests/delivery-state-machine.test.ts

npm run verify
git diff --check
git status --short
```

Complete fresh read-only verification and independent review against the frozen candidate. Reviewers still report all meaningful concerns, but only established in-scope defects block automatically. Contract expansion requires parent/user judgment. Subagent exhaustion blocks completion and never produces a forced PASS. Any repair requires the focused/full checks and fresh independent gates again.

Expected changed files:

- `extensions/delivery-state-machine/phases/verify.md`
- `extensions/delivery-state-machine/phases/review.md`
- `extensions/delivery-state-machine/prompts/deliver.md`
- `extensions/delivery-state-machine/index.ts` only if matching hardcoded guidance requires it
- `extensions/delivery-state-machine/tests/delivery-state-machine.test.ts`
- `extensions/delivery-state-machine/README.md`
- `extensions/delivery-state-machine/IMPROVEMENT_PLAN.md`

Do not commit `.pi-subagents/` or modify Git cleanup source/tests.

## Parallelization

Sequential implementation in one worktree and one merge request. Prompts, parent guidance, tests, README, and `IMPROVEMENT_PLAN.md` express one shared contract; parallel writers would create wording and expectation drift. Fresh read-only verification and review may run independently after the candidate is frozen, with the parent aggregating findings under the same scope contract.

## Execution checklist

- [ ] Implement and document the bounded-review prerequisite in one latest-main worktree/MR, prove the focused regressions and full verification, complete fresh independent gates without parent fallback, merge it before resuming `IMPROVEMENT_PLAN.md`, then rebaseline that plan from updated `main`.
