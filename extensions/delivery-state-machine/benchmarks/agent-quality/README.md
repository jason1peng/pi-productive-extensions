# Delivery-agent quality framework

This directory contains the frozen, repository-owned framework used to compare packaged `dsm.*` agents with pi-subagents builtins. It prepares the controlled scenarios and runtime boundary; it does **not** run or interpret the Stage 7 comparative benchmark by itself.

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

## Later controlled evaluations

After the scenario/control set is reviewed and frozen, run a selected trial directly:

```bash
bun extensions/delivery-state-machine/benchmarks/agent-quality/run.ts run VER-01 dsm.verifier
```

Or use Promptfoo for the configured matrix (cache must remain disabled):

```bash
npx promptfoo@0.121.19 eval \
  -c extensions/delivery-state-machine/benchmarks/agent-quality/promptfooconfig.yaml \
  --no-cache
```

The configuration expands scenario/candidate trials but delegates launch, fixture provisioning, evidence joining, bounded infrastructure reruns, and scoring to `run.ts`. `maxInfrastructureAttempts` is fixed at `3`; changing it requires config validation and provider-boundary regression updates. When aggregating Promptfoo output, include only provider outputs with `harness.classification: scored` in candidate comparisons. Promptfoo error rows whose response metadata has `classification: infrastructure_exhausted` are operational evidence requiring rerun/investigation, never candidate losses. Pilot/full repetition counts and adoption decisions remain Stage 7 work; do not infer promotion from a canary or a single run.

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
