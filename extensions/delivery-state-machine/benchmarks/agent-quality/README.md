# Delivery-agent quality framework

This directory contains a Promptfoo-based evaluation harness for delivery-state-machine agents. It runs a delivery phase against a controlled repository fixture, captures what the agent actually did, and scores the result with deterministic checks.

Use it to answer developer questions such as:

- Does `dsm.implementer` complete an implementation task correctly?
- Does `dsm.verifier` find the expected supported defect?
- Does `dsm.reviewer` return the correct review verdict and evidence?
- Does `dsm.closer` create only the expected commit, ref, and PR action?
- How does a packaged `dsm.*` agent compare with the corresponding pi-subagents builtin?

## Supported phase evaluations

| Delivery phase | Packaged agent | Comparison agent |
|---|---|---|
| IMPLEMENT | `dsm.implementer` | `worker` |
| VERIFY | `dsm.verifier` | `reviewer` |
| REVIEW | `dsm.reviewer` | `reviewer` |
| CLOSE | `dsm.closer` | `delegate` |
| RETRO | `dsm.retrospective` | `delegate` |

Each phase currently has two scenarios, for ten scenarios total. A scenario defines the task, repository fixture, launch settings, allowed mutations, controls, artifact contract, and deterministic scorers.

## Start here

For normal development, run the offline checks first. They do not launch Pi or call a model:

```bash
npm install --no-audit --no-fund
npm run eval:dsm-agents:validate
npm run test
npm run verify
```

To run one scenario against one agent:

```bash
bun extensions/delivery-state-machine/benchmarks/agent-quality/run.ts run VER-01 dsm.verifier
```

To run the configured matrix:

```bash
npm run eval:dsm-agents
```

To test the real Pi → pi-subagents boundary, use the opt-in canary described below. It requires credentials and makes two model calls.

## How it works

A trial follows this path:

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
| `canary.ts` | Small real-Pi integration check. |
| `tests/` | Model-free regression tests. |
| `artifacts/raw/` | Ignored evidence from runs; never commit it. |

## How to modify it

### Add or change a scenario

1. Add or update its repository under `fixtures/`.
2. Add or update the matching JSON record under `scenarios/`.
3. Update `catalog.ts` only when adding a new candidate or scenario identifier.
4. Add a focused regression in `tests/framework.test.ts`.
5. Run `npm run eval:dsm-agents:validate` and `npm run verify`.

### Change runtime or isolation behavior

Edit `runtime.ts` for Pi/session/process behavior, or `provision.ts` for repositories, environment, credentials, Git, and cleanup. Add tests for success, failure, timeout/cancellation, and cleanup. Then run the full offline suite and the real-Pi canary.

### Change scoring or result fields

Update `schema.ts` and `scorers/` together. Update scenario expected outcomes and tests so malformed, opposite, missing, and infrastructure results are covered. Do not rely on prose keyword matching.

### Upgrade Promptfoo

Pin one exact version in `package.json` and the lockfile. Then run configuration validation, the full offline suite, the Promptfoo provider-boundary tests, and the real-Pi canary.

## Guarantees and limits

Each trial gets a unique disposable Git repository, Pi agent home, local-only remote when needed, PR-command stub, artifact path, and process group. The runner removes inherited nested-agent/intercom identity, passes an explicit environment allowlist, provisions only auth-file entries required by the outer and child model providers, requires the parent launch call to carry the scenario's requested thinking in pi-subagents' supported model-suffix argument, overrides both candidates to the scenario's exact tool set, captures the resolved agent configuration, enforces a deadline, joins pi-subagents metadata to exactly one child session, and scores deterministic runtime, completion, artifact, behavior, mutation, Git, and usage evidence.

The fixtures and candidates are trusted test inputs. Tool restrictions and local remotes are behavioral safeguards, **not** a container, firewall, hostile-code sandbox, or egress security boundary. Do not add untrusted code, production credentials, production paths, or real remotes.

Deterministic critical failures decide the result. Scenario-specific `eval-evidence` JSON must match the fixture's hidden versioned known-outcome choice under exact normalized values or a small scorer-owned allowlist of reviewed aliases; unrestricted substring matching is forbidden because negated claims must fail. Prose keywords alone cannot satisfy artifact scoring. Evaluated children receive a versioned field/type shape plus reviewed, plausible bounded choices, then select values from their own fixture and control investigation. Choice order is deterministically mixed by scenario and field, so no fixed position identifies correctness; which choice is expected and all scorer aliases remain runner-only. Git and PR wrappers retain attempted mutation history, including reversed staging/reset and no-op pushes, while CLOSE scoring checks the exact reviewed commit tree, local ref, and PR-create stub result. Supplemental model grading cannot reverse deterministic evidence. Infrastructure failures are unscored and retried by the repository provider up to three total attempts. A later PASS or CANDIDATE_FAILURE is scored normally; bounded exhaustion remains `INFRASTRUCTURE_FAILURE` and the provider returns a Promptfoo `UNSCORED_INFRASTRUCTURE_FAILURE` error instead of candidate output, so candidate assertions do not run and Promptfoo records an error rather than a candidate pass/failure. The full normalized exhausted result is retained in provider metadata. That result and its attempt manifest preserve each attempt's status, completion, diagnostics, scorer state, evidence/artifact paths, runtime identity, redaction result, and available outer/child usage. Missing optional usage or cost telemetry is reported as unavailable and never guessed. Outer-orchestrator usage is stored separately from child usage.

## Install and validate offline

The lockfile exact-pins `promptfoo@0.121.19`.

```bash
npm install --no-audit --no-fund
npm run eval:dsm-agents:validate
npm run test
npm run verify
```

These commands use fake-runtime tests and configuration validation only. They must not launch Pi or call a model provider. Any Promptfoo upgrade must be exact-pinned and followed by the complete offline suite and real-Pi canary.

## Opt-in real-Pi canary

The canary proves discovery, requested/effective identity, retained authoritative child metadata, artifact capture, child/outer usage separation, redaction, and cleanup for one trivial verifier scenario. It is framework evidence, not comparative evidence.

```bash
DSM_AGENT_EVAL_CANARY=1 \
DSM_AGENT_EVAL_OUTER_MODEL=openai-codex/gpt-5.6-sol \
npm run eval:dsm-agents:canary
```

Requirements:

- `pi` on `PATH` (or `PI_BIN`)
- pi-subagents at `~/.pi/agent/npm/node_modules/pi-subagents` (or `PI_SUBAGENTS_ROOT`)
- model credentials in `~/.pi/agent/auth.json` or `PI_AGENT_AUTH_FILE`, keyed by the provider IDs used by the outer and child models; unrelated provider entries are not copied into the isolated home
- enough quota for one outer session and one child

The command fails clearly for missing runtime dependencies, authentication/quota failure, identity mismatch, malformed artifacts, or cleanup/redaction failure. Redaction scanning compares retained evidence against both allowlisted environment credentials and ephemeral credential/token values extracted from the selected auth file; those comparison values are never retained in normalized or raw evidence. Expect two model sessions; exact cost depends on the configured provider and model and is read from runtime telemetry only.

## Run evaluations

Run a selected trial directly:

```bash
bun extensions/delivery-state-machine/benchmarks/agent-quality/run.ts run VER-01 dsm.verifier
```

Or use Promptfoo for the configured matrix (cache must remain disabled):

```bash
npx promptfoo@0.121.19 eval \
  -c extensions/delivery-state-machine/benchmarks/agent-quality/promptfooconfig.yaml \
  --no-cache
```

The configuration expands the scenario/candidate matrix, while `run.ts` handles launch, fixture provisioning, evidence collection, retries, and scoring. `maxInfrastructureAttempts` is fixed at `3`; changing it requires config validation and provider-boundary regression updates.

When reading Promptfoo results:

- compare rows whose provider output has `harness.classification: scored`;
- treat `PASS` as a successful candidate run;
- treat `CANDIDATE_FAILURE` as a scored candidate failure;
- treat Promptfoo error rows with `classification: infrastructure_exhausted` as environment/runtime failures to investigate or rerun, not candidate losses.

A canary proves that the real runtime integration works. It does not replace running the scenarios needed for your evaluation.

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
