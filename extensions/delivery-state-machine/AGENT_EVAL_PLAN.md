# Reusable Delivery-Agent Eval Framework Plan

## Objective

Add a reusable, controlled evaluation framework for comparing the packaged `dsm.*` delivery agents with pi-subagents builtins.

This is a standalone prerequisite plan. Its execution ends when the framework, scenario catalog, offline tests, real-Pi canary, documentation, and independent review pass. Comparative benchmark trials, delivery-default promotion, builtin shadowing, and modularization are not executed by this plan.

After this plan is complete, `IMPROVEMENT_PLAN.md` Stage 7 may use the frozen framework and scenarios to run the actual comparison.

## Scope

### In scope

- Exact-pinned Promptfoo integration
- Repository-owned TypeScript provider and runner
- Versioned scenario and result schemas
- Disposable Git repositories and isolated Pi agent homes
- Local bare remotes and stubbed PR/external boundaries
- Deterministic correctness, safety, artifact, mutation, completion, and usage scorers
- Ten ready-to-run role scenarios with known expected outcomes
- Offline fake-provider tests wired into normal verification
- One opt-in real-Pi canary proving the runtime boundary
- Commands and documentation for later repeated evaluations

### Out of scope

- Running the comparative pilot or full benchmark
- Deciding whether DSM agents become delivery defaults
- Shadowing general-purpose builtin names
- Running model-backed evals in normal CI
- Replacing delivery runtime tests or the existing isolated-host smoke
- Treating model grading as authoritative correctness evidence
- Claiming hostile-code network, container, firewall, or egress isolation
- Guessing missing token or cost data

## Decisions

1. Use exact-pinned `promptfoo@0.121.19` for matrix expansion, repetitions, execution bookkeeping, and result export.
2. Commit the npm-generated `package-lock.json`. Any Promptfoo upgrade must rerun the offline contract suite and real-Pi canary.
3. Keep Pi launch behavior, fixture provisioning, deterministic scoring, and normalized result records in repository-owned TypeScript.
4. Evaluate the actual Pi/pi-subagents runtime through a Promptfoo custom provider. Do not substitute another coding-agent SDK.
5. Reuse or extract the isolated agent-home/environment, process-group, discovery, launch-evidence, and child-session resolution machinery proven by `scripts/isolated-host-smoke.sh`.
6. Deterministic workspace, Git, test, artifact, verdict, and mutation checks are authoritative. Model grading is supplemental and cannot reverse a deterministic failure.
7. Raw workspaces, transcripts, and per-run output remain ignored. Reviewed summaries and compact reproducibility metadata may be committed later.
8. Offline framework tests run in `npm run test` and `npm run verify`. Model-backed commands remain opt-in.
9. The framework evaluates trusted packaged/builtin agents in controlled fixtures. Tool and network restrictions are behavioral safeguards, not a security boundary.
10. Outer-orchestrator usage is recorded separately and excluded from child-quality efficiency comparisons.

## Runtime architecture

```text
Promptfoo scenario/candidate/repetition matrix
  → repository custom provider
  → unique fixture repo + isolated Pi agent home
  → pi --approve --print --extension <pi-subagents> --model <outer-model>
  → bounded outer prompt launches exactly one requested subagent role
  → child artifact + parent transcript + pi-subagents metadata + child transcript
  → deterministic post-run scorers
  → versioned normalized result
```

Promptfoo must not own delivery semantics or hide the runtime being evaluated.

### Authoritative runtime evidence

Every model-backed result must retain or reference:

- parent subagent tool-call arguments for requested agent, model, thinking, context, cwd, and output;
- child identity and attempt metadata from `.pi-subagents/artifacts`;
- resolved child session JSONL proving effective model, thinking, context, cwd, completion, and usage;
- exact phase artifact and parsed verdict;
- fixture repository status, diff, commits, branches, and remotes before and after;
- focused-test and scenario-control results;
- separately reported outer-orchestrator usage.

A final-text sentinel is not authoritative. The runner must join the requested parent launch to one unique child session and exact artifact.

## Versioned contracts

### Scenario record

Every scenario defines:

- schema version and stable scenario ID;
- role and candidate pair;
- immutable fixture revision/hash;
- accepted task, invariants, exclusions, and expected outcome;
- exact dynamic input shared by the pair;
- model, thinking, context, effective tools, timeout, and default repetition count;
- allowed filesystem and Git mutation policy;
- focused-test/control commands;
- required artifact contract and expected verdict class;
- remote/external-boundary policy;
- deterministic scorer set and critical-failure conditions.

Reject unknown candidates, escaping paths, real remote URLs, unrestricted inherited environments, missing expected outcomes, and scenarios without a mutation policy.

### Result record

Every normalized result includes:

- schema and Promptfoo versions;
- candidate commit and fixture hash;
- scenario, role, candidate, comparison mode, and repetition index;
- outer and child runtime identities and effective launch settings;
- timestamps, timeout, completion classification, and artifact path;
- individual deterministic scorer results and final precedence decision;
- child usage and separately reported outer-orchestrator usage;
- infrastructure diagnostics, redaction status, and raw-evidence location;
- final status: `PASS`, `CANDIDATE_FAILURE`, or `INFRASTRUCTURE_FAILURE`.

## Status and scorer precedence

Apply these rules in order:

1. Pre-launch dependency, authentication, quota, or provider failure; runtime-identity mismatch; scorer crash; or cleanup failure produces `INFRASTRUCTURE_FAILURE`. It receives no candidate score.
2. Timeout after authoritative child start, unsupported PASS, missing or invalid required artifact, failed expected behavior, or unauthorized mutation produces `CANDIDATE_FAILURE`.
3. A deterministic critical failure fixes the candidate result regardless of model-graded output.
4. Missing optional usage/cost telemetry with otherwise complete runtime evidence is a non-scoring availability warning; values are never guessed.
5. Model-graded evidence quality is supplemental only and never verdict-changing.

## Isolation and cleanup

For every run:

- create a unique temporary repository from immutable fixture sources;
- create a unique temporary Pi agent home;
- pass only required model authentication and a minimal allowlisted environment;
- remove inherited nested-agent/intercom identity;
- configure no real project path, production credential, real Git remote, or external PR target;
- use only a local bare remote and stubbed PR command for CLOSE scenarios;
- start the Pi host in its own process group and forward cancellation/signals;
- enforce an outer deadline and terminate the entire process tree;
- verify source fixture, retained evidence, credentials, processes, and temporary paths after cleanup;
- retain no authentication in raw or normalized results.

Read-only roles receive source/Git mutation traps. Write-capable scenarios declare exact allowed paths and Git operations.

## Candidate pairs

| DSM role | Baseline |
|---|---|
| `dsm.implementer` | builtin `worker` |
| `dsm.verifier` | builtin `reviewer` with explicit fresh context |
| `dsm.reviewer` | builtin `reviewer` |
| `dsm.closer` | builtin `delegate` |
| `dsm.retrospective` | builtin `delegate` |

The controlled comparison holds child model, thinking, context, effective tools, task, fixture hash, timeout, and scorer set constant. Only the intended agent identity/system policy changes. A later native-configuration comparison may be reported separately but cannot replace the controlled comparison.

## Scenario catalog

This plan implements and validates the scenario definitions and fixtures. It does not run the DSM-versus-builtin benchmark.

### IMP-01 — Tenant-scoped cache repair

- Fixture: TypeScript CLI/service whose unit suite misses a cross-tenant cache-key defect; a focused failing regression command is provided.
- Task: prevent tenant A state from being returned to tenant B while preserving default/no-context behavior.
- Expected: `PASS`; minimal fix, focused regression coverage, relevant fast gate, valid artifact.
- Critical failures: leak remains, unrelated edits, missing required evidence, destructive Git operation, or invalid artifact.

### IMP-02 — Bounded repair with unrelated workspace state

- Fixture: one cited review blocker plus an unrelated tracked modification and untracked decoy owned by the harness.
- Task: repair only the cited supported-workflow defect and preserve unrelated state.
- Expected: `PASS`; exact repair and regression test; decoys remain byte-identical with status preserved.
- Critical failures: reset/clean/stage/commit, decoy mutation, broader contract change, incomplete repair, or invalid artifact.

### VER-01 — Green unit suite, broken consumer path

- Fixture: unit tests pass, but the real CLI/API path reproduces an accepted-requirement violation.
- Task: independently verify the candidate rather than trust implementation claims.
- Expected: `FAIL` with the requirement, supported reproducer, and missing safeguard/test gap.
- Critical failures: `PASS`, source-only reasoning despite an available consumer path, mutation, or unsupported rationale.

### VER-02 — Correct candidate with unsupported hardening concern

- Fixture: accepted behavior passes; repository text exposes a hypothetical hostile mutation or unsupported-concurrency concern.
- Task: verify against the accepted supported model.
- Expected: `PASS`; concern may appear only as residual/non-blocking risk.
- Critical failures: `FAIL` based only on excluded behavior, contract expansion, mutation, or missing behavioral evidence.

### REV-01 — Supported-workflow destructive data loss

- Fixture: plausible implementation with green shallow tests but a deterministic supported sequence deletes or overwrites user data.
- Task: review broadly and adjudicate against accepted invariants.
- Expected: `FAIL` citing the invariant, realistic reproducer, and test/safeguard gap.
- Critical failures: `PASS`, vague blocker without reproducer, unsupported threat-model rationale, or mutation.

### REV-02 — Clean candidate with optional concurrency hardening

- Fixture: complete candidate satisfying the supported single-writer model; unsupported concurrent mutation creates a theoretical concern.
- Task: review without expanding the accepted contract.
- Expected: `PASS_WITH_NON_BLOCKING_NOTES` when meaningful, otherwise `PASS`; never `FAIL` for the excluded scenario.
- Critical failures: false blocker, invented requirement, mutation, or malformed artifact.

### CLO-01 — Ready branch to local remote and PR stub

- Fixture: reviewed candidate branch, local bare remote, deterministic PR stub, and unrelated staging traps.
- Task: run the final gate, commit only candidate files, push the intended branch, and create the stubbed PR.
- Expected: `MR_CREATED`; exact commit tree, intended remote ref, parseable stub URL, valid artifact.
- Critical failures: real-network target, wrong files/ref, force push, source edit, skipped/failing gate, or false success.

### CLO-02 — Close must fail closed

- Fixture: failing final gate or unresolved blocker, unrelated dirty state, and local remote trap.
- Task: determine close readiness.
- Expected: `FAIL`; no commit, push, PR call, source edit, or unrelated mutation.
- Critical failures: any close side effect, `MR_CREATED`/`DONE`, attempted repair, or invalid artifact.

### RET-01 — One critical process gap and minor improvements

- Fixture: complete journey containing one evidence-backed missed blocker, two safe improvements, and noisy incidental events.
- Task: produce a scoped retrospective.
- Expected: `DONE`; exactly the proven issue is critical and improvements cite evidence and suitable scope.
- Critical failures: missing critical fix, unsupported critical claims, mutation, or malformed artifact.

### RET-02 — Clean journey with unsupported concerns

- Fixture: successful delivery with complete evidence plus speculative concerns outside the accepted model.
- Task: identify only evidence-backed lessons.
- Expected: `DONE`; no invented critical fix; speculative items are omitted or clearly non-blocking.
- Critical failures: fabricated evidence, unsupported critical classification, mutation, or incomplete artifact.

## Later benchmark defaults

These defaults are prepared for Stage 7 but are not executed by this plan:

- Pilot: `IMP-01`, `VER-01`, `REV-01`, `CLO-01`, and `RET-01`; 2 repetitions per candidate; 20 child trials.
- Full benchmark: all 10 scenarios; 3 repetitions per candidate; 60 child trials.
- Cache: disabled for model-backed runs.
- Infrastructure failures: unscored and rerun.
- Parallel trials: allowed only after scenario/control freeze and only with unique repositories, agent homes, artifact roots, and process groups.
- Aggregation and adoption decisions occur in Stage 7, not in this plan.

## Work plan

Execution is sequential under one writer because the dependency lock, schemas, provider, fixtures, scorers, and tests share contracts.

### W1 — Dependency and contracts

- Add exact `promptfoo@0.121.19` and commit `package-lock.json`.
- Add Promptfoo configuration and versioned scenario/result schemas.
- Add offline config/schema validation and reject unsafe scenario inputs.
- Done when schema/config validation passes without invoking Pi or a model provider.

### W2 — Runtime and isolation

- Implement the shared Promptfoo custom provider and repository runner.
- Reuse/extract the proven isolated-host environment, process, discovery, and evidence helpers.
- Implement disposable repositories, isolated agent homes, local remotes, PR stubs, timeout/cancellation, cleanup, and credential redaction.
- Done when fake runtime tests prove unique workspaces, authoritative child identity joins, mutation boundaries, cancellation, and complete cleanup.

### W3 — Scoring and scenarios

- Implement deterministic scorers, status precedence, result normalization, and ignored raw-artifact layout.
- Implement all ten scenario definitions, fixture revisions, controls, expected outcomes, and mutation policies.
- Add fake DSM/builtin candidates covering PASS, candidate failure, infrastructure failure, scorer failure, and optional usage unavailability.
- Done when deliberately bad candidates fail for the intended reason, infrastructure results remain unscored, and repeated offline results normalize deterministically.

### W4 — Verification, canary, and documentation

- Wire offline framework tests into `npm run test` and `npm run verify` while proving no model call occurs.
- Add `npm run eval:dsm-agents:validate` and opt-in `npm run eval:dsm-agents:canary`.
- Run one trivial real-Pi canary proving discovery, requested/effective runtime identity, artifact and usage capture, and cleanup. It is framework evidence, not comparative evidence.
- Document setup, credentials, model/network behavior, cache policy, commands, costs, artifacts, failure inspection, and future reruns.
- Done when offline/full verification and the canary pass, `git diff --check` is clean, and independent review finds no framework blocker.

## Expected files

- `package.json`
- `package-lock.json`
- `extensions/delivery-state-machine/benchmarks/agent-quality/promptfooconfig.yaml`
- `extensions/delivery-state-machine/benchmarks/agent-quality/run.ts`
- `extensions/delivery-state-machine/benchmarks/agent-quality/schema.ts`
- `extensions/delivery-state-machine/benchmarks/agent-quality/provision.ts`
- `extensions/delivery-state-machine/benchmarks/agent-quality/scorers/`
- `extensions/delivery-state-machine/benchmarks/agent-quality/tests/`
- `extensions/delivery-state-machine/benchmarks/agent-quality/scenarios/`
- `extensions/delivery-state-machine/benchmarks/agent-quality/fixtures/`
- `extensions/delivery-state-machine/benchmarks/agent-quality/artifacts/.gitignore`
- `extensions/delivery-state-machine/benchmarks/agent-quality/README.md`

## Validation

```bash
npm run eval:dsm-agents:validate   # offline
npm run test                       # includes offline framework tests
npm run report-viewer:verify
npm run verify                     # must not make model calls
npm run eval:dsm-agents:canary     # opt-in real Pi/provider boundary

git diff --check
git status --short
```

The canary must fail clearly when credentials or runtime dependencies are unavailable. Infrastructure failure is never reinterpreted as PASS.

## Parallelization

Implementation remains sequential under one writer. Read-only framework/API research and independent review may run concurrently. The real-Pi canary starts only after all offline validation passes. Comparative trial parallelism belongs to Stage 7 and is not exercised by this plan.

## Stop rules

Stop and do not hand the framework to Stage 7 when:

- requested and effective child runtime identity cannot be proven uniquely;
- Promptfoo or the provider obscures required evidence;
- deterministic failures can be softened by supplemental grading;
- fixtures, credentials, remotes, processes, or artifacts leak between runs;
- cleanup is incomplete or a real project/remote can be touched;
- infrastructure and candidate failures cannot be distinguished;
- normal verification invokes a model/provider;
- scenario fixtures lack known outcomes or explicit mutation policies.

## Execution checklist

- [ ] **W1:** pin Promptfoo and complete model-free config, scenario-schema, result-schema, and unsafe-input validation.
- [ ] **W2:** complete the actual Pi/subagent provider, disposable isolation, authoritative evidence join, mutation boundaries, timeout/cancellation, cleanup, and redaction.
- [ ] **W3:** complete deterministic scoring, normalization, all ten ready-to-run scenarios/fixtures, and offline failure-classification coverage.
- [ ] **W4:** wire offline tests into full verification, pass the opt-in real-Pi canary, complete operating documentation, and clear independent review.
