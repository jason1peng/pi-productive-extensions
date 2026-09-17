# Delivery-agent quality framework (historical/frozen)

> Historical/frozen evaluation material. The packaged `dsm.*` runtime agents and their direct package commands were retired after Stage 7. This directory remains immutable evaluation input consumed by `benchmarks/model-quality`; it is not a current runtime or supported agent-selection surface.

This directory contains the Promptfoo-based evaluation harness used for the historical delivery-state-machine agent comparison. It runs a delivery phase against a controlled repository fixture, captures what the agent actually did, and scores the result with deterministic checks.

Use it to answer developer questions such as:

- Does `dsm.implementer` complete an implementation task correctly?
- Does `dsm.verifier` find the expected supported defect?
- Does `dsm.reviewer` return the correct review verdict and evidence?
- Does `dsm.closer` create only the expected commit, ref, and PR action?
- How does a packaged `dsm.*` agent compare with the corresponding pi-subagents builtin?

## Historical phase evaluations

| Delivery phase | Packaged agent | Comparison agent |
|---|---|---|
| IMPLEMENT | `dsm.implementer` | `worker` |
| VERIFY | `dsm.verifier` | `reviewer` |
| REVIEW | `dsm.reviewer` | `reviewer` |
| CLOSE | `dsm.closer` | `delegate` |
| RETRO | `dsm.retrospective` | `delegate` |

The frozen catalog has two scenarios per phase, for ten scenarios total. A scenario defines the task, repository fixture, launch settings, allowed mutations, controls, artifact contract, and deterministic scorers.

## Historical findings

The reviewed Stage 7 comparison is documented in [`reports/2026-07-20-stage7-agent-comparison.md`](reports/2026-07-20-stage7-agent-comparison.md). Both candidate families passed all deterministic trials after DSM prompt simplification. The then-recorded decision retained the builtin-based delivery default and an optional namespaced profile because DSM showed no deterministic quality advantage and remained more expensive and slower. That decision is historical; the packaged profile and agents are no longer available.

## Current use

No standalone agent-quality command is exposed. The runtime, schema, scenario, and report assets remain frozen inputs for `benchmarks/model-quality`. For current model-free validation, use the model-quality commands from the repository root:

```bash
npm run eval:models:validate
npm run eval:models:fake-full
npm run eval:models:audit
npm run verify
```

The historical matrix was serial, used one repetition by default, and comprised 20 autonomous agent trials (60 with three repetitions). Its retained report and protected inputs are evidence only; they must not be used to select an unavailable packaged agent.

## How it works

A historical trial followed this path:

1. `catalog.ts` loads a record from `scenarios/`.
2. `provision.ts` copies its `fixtures/` repository into an isolated temporary workspace.
3. `runtime.ts` launches Pi and the selected child agent with the required model, tools, and context.
4. `scorers/` checks the artifact, behavior, workspace, Git activity, runtime identity, and usage evidence.
5. `run.ts` returns a normalized result and cleans the temporary workspace.
6. Infrastructure failures are retried up to three times; they are not counted as candidate failures.

## Directory structure

| Path | Purpose |
|---|---|
| `run.ts` | Main CLI and Promptfoo provider; coordinates trials and retries. |
| `runtime.ts` | Launches Pi, manages signals/timeouts, and joins child session evidence. |
| `provision.ts` | Creates isolated repositories, environments, local remotes, and cleanup state. |
| `schema.ts` | Defines and validates scenarios, results, and attempt manifests. |
| `catalog.ts` | Loads candidates and scenario records. |
| `scenarios/` | Ten versioned scenario definitions. |
| `fixtures/` | Test repositories, setup scripts, controls, and expected behavior inputs. |
| `scorers/` | Deterministic result checks and precedence rules. |
| `promptfooconfig.yaml` | Promptfoo candidate/scenario matrix and retry settings. |
| `canary.ts` | Historical real-Pi integration check. |
| `tests/` | Model-free regression tests. |
| `artifacts/raw/` | Ignored evidence from runs; never commit it. |

## How to modify it

### Historical scenario maintenance

The scenario and runtime files are frozen Stage 7 inputs. Do not add a current candidate, change a scenario, or alter the historical comparison without a new, explicitly approved evaluation record and updated model-quality preservation sentinels.

### Change runtime or isolation behavior

Edit `runtime.ts` for Pi/session/process behavior, or `provision.ts` for repositories, environment, credentials, Git, and cleanup. Add tests for success, failure, timeout/cancellation, and cleanup. Then run the full offline suite and the real-Pi canary.

### Change scoring or result fields

Update `schema.ts` and `scorers/` together. Update scenario expected outcomes and tests so malformed, opposite, missing, and infrastructure results are covered. Do not rely on prose keyword matching.

### Upgrade Promptfoo

Promptfoo version and the historical comparison inputs are frozen. A future evaluation must pin one exact version, update the preserved evaluation record, and pass the model-quality preservation gates before any change is accepted.

## Guarantees and limits

Each trial gets a unique disposable Git repository, Pi agent home, local-only remote when needed, PR-command stub, artifact path, and process group. The runner removes inherited nested-agent/intercom identity, passes an explicit environment allowlist, provisions only auth-file entries required by the outer and child model providers, requires the parent launch call to carry the scenario's requested thinking in pi-subagents' supported model-suffix argument, overrides both candidates to the scenario's exact tool set, captures the resolved agent configuration, enforces a deadline, joins pi-subagents metadata to exactly one child session, and scores deterministic runtime, completion, artifact, behavior, mutation, Git, and usage evidence.

The fixtures and candidates are trusted test inputs. Tool restrictions and local remotes are behavioral safeguards, **not** a container, firewall, hostile-code sandbox, or egress security boundary. Do not add untrusted code, production credentials, production paths, or real remotes.

Deterministic critical failures decide the result. Scenario-specific `eval-evidence` JSON must match the fixture's hidden versioned known-outcome choice under exact normalized values or a small scorer-owned allowlist of reviewed aliases; unrestricted substring matching is forbidden because negated claims must fail. Prose keywords alone cannot satisfy artifact scoring. Evaluated children receive a versioned field/type shape plus reviewed, plausible bounded choices, then select values from their own fixture and control investigation. Choice order is deterministically mixed by scenario and field, so no fixed position identifies correctness; which choice is expected and all scorer aliases remain runner-only. Git and PR wrappers retain attempted mutation history, including reversed staging/reset and no-op pushes, while CLOSE scoring checks the exact reviewed commit tree, local ref, and PR-create stub result. Supplemental model grading cannot reverse deterministic evidence. Infrastructure failures are unscored and retried by the repository provider up to three total attempts. A later PASS or CANDIDATE_FAILURE is scored normally; bounded exhaustion remains `INFRASTRUCTURE_FAILURE` and the provider returns a Promptfoo `UNSCORED_INFRASTRUCTURE_FAILURE` error instead of candidate output, so candidate assertions do not run and Promptfoo records an error rather than a candidate pass/failure. The full normalized exhausted result is retained in provider metadata. That result and its attempt manifest preserve each attempt's status, completion, diagnostics, scorer state, evidence/artifact paths, runtime identity, redaction result, and available outer/child usage. Missing optional usage or cost telemetry is reported as unavailable and never guessed. Outer-orchestrator usage is stored separately from child usage.

## Validate preserved inputs offline

The lockfile retains the historical exact pin `promptfoo@0.121.19`. Current validation is model-free and must preserve the frozen Stage 7 inputs:

```bash
npm run eval:models:validate
npm run eval:models:fake-full
npm run eval:models:audit
npm run verify
```

These commands must not launch Pi or call a model provider. The former direct DSM-agent evaluation entry points are retired.

## Historical real-Pi canary

The former canary proved discovery, requested/effective identity, retained authoritative child metadata, artifact capture, child/outer usage separation, redaction, and cleanup for one trivial verifier scenario. Its output is historical framework evidence, not a current runtime capability, and it has no supported package command.

Historical requirements (for interpreting the retained record):

- `pi` on `PATH` (or `PI_BIN`)
- pi-subagents at `~/.pi/agent/npm/node_modules/pi-subagents` (or `PI_SUBAGENTS_ROOT`)
- model credentials in `~/.pi/agent/auth.json` or `PI_AGENT_AUTH_FILE`, keyed by the provider IDs used by the outer and child models; unrelated provider entries are not copied into the isolated home
- enough quota for one outer session and one child

The historical canary failed clearly for missing runtime dependencies, authentication/quota failure, identity mismatch, malformed artifacts, or cleanup/redaction failure. Redaction scanning compared retained evidence against both allowlisted environment credentials and ephemeral credential/token values extracted from the selected auth file; those comparison values were never retained in normalized or raw evidence. Expect two model sessions in the retained historical record; exact cost depended on the configured provider and model.

## Historical evaluation record

The frozen Promptfoo configuration and runner retain the exact scenario/candidate matrix used for Stage 7 reproducibility. They are not current commands: direct selection of a packaged DSM agent is retired. Read the dated report and protected model-quality inputs when historical evidence is needed; do not launch a new comparison from this package.

When reading Promptfoo results:

- compare rows whose provider output has `harness.classification: scored`;
- treat `PASS` as a successful candidate run;
- treat `CANDIDATE_FAILURE` as a scored candidate failure;
- treat Promptfoo error rows with `classification: infrastructure_exhausted` as environment/runtime failures to investigate or rerun, not candidate losses.

The retained canary record documents the historical runtime integration. It does not authorize selecting or restoring a retired packaged agent.

## Evidence and failure inspection

Raw workspaces, transcripts, stderr, Git evidence, scorer details, the uniquely joined child metadata record, and per-run artifacts are written below `artifacts/raw/` and ignored by Git. Normalized results include schema/Promptfoo versions, candidate commit, immutable fixture hash, effective launch identity, retained child session/metadata references, separate outer/child usage, completion classification, scorer precedence, diagnostics, redaction status, raw-evidence path, and the bounded harness attempt manifest. Each infrastructure attempt retains its own evidence path and telemetry summary even when a later attempt becomes the scored result.

For a failure, inspect in this order:

1. `diagnostics` and final `status` to distinguish infrastructure from candidate failure.
2. `scorers.json` for the first critical deterministic failure.
3. requested/effective child identity, resolved effective tools, retained `child-metadata.json`, and child session evidence.
4. exact phase artifact, structured `eval-evidence`, and fixture control output.
5. `git.json` (including audited command attempts and close-tree evidence), retained workspace, outer stderr, and transcript.

Never commit raw transcripts or authentication. Reviewed compact summaries may be committed later only after redaction and fixture/control freeze.

## Contracts and scenarios

- `schema.ts` rejects unknown candidates, escaping paths, real remote URLs, inherited environments, missing expected outcomes/mutation policies, and incomplete, malformed, or unknown normalized-result fields.
- `scenarios/*.json` contains ten versioned, hash-pinned scenario records.
- `fixtures/` contains immutable fixture revisions and known behavior controls.
- `provision.ts` owns disposable repositories, local remotes, audited Git/PR stubs, environment isolation, and cleanup.
- `runtime.ts` owns bounded Pi launch, controlled tool overrides, resolved-agent evidence, and authoritative metadata/session joining.
- `scorers/` owns structured known-outcome checks, exact close/Git policy, deterministic precedence, and normalization.
