# Phase-model qualification infrastructure

This PPE-001 layer extends the frozen [`agent-quality`](../agent-quality/README.md) Stage 7 harness. It does **not** replace that harness, create another Pi/isolation stack, qualify a model, or change delivery routing.

> **INFRASTRUCTURE_ONLY — NOT QUALIFICATION EVIDENCE**

All committed tasks here are immutable bootstrap assets with `datasetClass: bootstrap` and `qualificationEligible: false`. Schema validation, manifest admission, report generation, and the adoption API enforce that prohibition independently. A bootstrap ID/version can never be relabeled; future approved golden assets use new IDs or immutable successor versions under PPE-002.

## Architecture

```text
explicit sparse manifest (no implicit cross product)
  -> versioned dataset registry
  -> frozen Stage 7 isolation/runtime/scoring boundary
  -> phase deterministic precedence
  -> optional blinded supplemental judge pack
  -> hash-linked human record
  -> redacted content-addressed evidence
  -> joined infrastructure-only report
```

Stage 7 files and all ten scenario records are protected by `bootstrap/stage7-sentinels.json`. The old Promptfoo matrix remains available as a frozen regression mode; PPE-001 only accepts explicitly enumerated sparse rows.

## Model-free commands

```bash
npm run eval:models:validate
npm run eval:models:fake-full
npm run eval:models:audit
npm run test
npm run verify
```

`validate` checks the sparse manifest, immutable registry, all-phase/E2E adapter coverage, judge collisions, bootstrap eligibility, and Stage 7 sentinels. `fake-full` exercises all phase adapters, supplemental pack creation, human-record plumbing, durable evidence round trip, joined arithmetic, and the E2E handoff join. `audit` reproduces the committed expected report byte-for-byte.

Normal CI and `npm run verify` remain model-free. `scripts/test-with-host-modules.sh` makes host discovery deterministic without mutating the host: it copies the installed `pi-subagents` package into a disposable module root, supplies the source lockfile's exact `typebox@1.1.38` peer, requires the host-discovery smoke to execute, and deletes the copy. A skipped host smoke is a failure under the default command. Raw evidence and disposable workspaces stay under ignored `artifacts/` or a separately selected absolute durable evidence root.

## Bootstrap coverage

The manifest contains exactly six frozen rows: IMPLEMENT, VERIFY, REVIEW, CLOSE, RETRO, and one E2E handoff row. Canned tests cover deterministic failures, false results, unsupported blockers, infrastructure classification, retries/exhaustion, identity/judge collision, malformed evaluator output, human states, evidence/redaction failures, cleanup, handoff completeness, metrics, holds, quarantine, and both incident/publication linearization orders.

CLOSE rejects default judge admission. Other judge packs are tool-less data contracts containing only the accepted contract, anonymized eligible outputs, randomized order/nonce, deterministic eligibility summary, and rubric. They exclude identity, cost, latency, raw transcripts, and chain-of-thought. A judge cannot reverse a deterministic critical failure; a model-produced VERIFY/REVIEW blocker requires deterministic reproduction or affirmative hash-linked human confirmation.

## Incident and admission safety

`admission.ts` provides the PPE-001 synthetic policy injection seam. Only the allowlisted bootstrap incident service can create/escalate a persistent pending hold. It cannot clear, quarantine, or change lifecycle/admission state. Signed authorized humans alone can dismiss an unchanged-hash false positive or convert a pending hold to durable quarantine.

Selection, dispatch, result use, joins, and report publication share a per-item/version linearizable guard with incident holds in both fake and real runners. `EvidenceAdmissionCoordinator` journals content-addressed evidence retention together with guard publication/incident acknowledgement, verifies evidence existence before acknowledgement, and idempotently reconciles every crash boundary. Hold-first publications become `TAINTED_OR_INVALIDATED`; publication-first holds durably taint all linked publications before acknowledgement. A write-ahead journal, monotonic sequence, idempotency keys, startup reconciliation, and fail-closed stale-hash behavior cover crash/retry/restart paths. Holds never auto-expire and frozen slots are never substituted.

## Opt-in real canaries

The approved immutable I4 v3 configuration is frozen in `bootstrap/real-canary-config.json` and `bootstrap/real-canary-manifest.json`. It uses `openai-codex/gpt-5.6-sol` at low thinking for the participant and outer runtime, and the independent `openai-codex/gpt-5.5` family at high thinking for supplemental judging. It executes the existing builtin IMPLEMENT, VERIFY, two-reviewer REVIEW, CLOSE, and RETRO routes plus one complete E2E chain. CLOSE and E2E have no bootstrap judge.

```bash
MODEL_QUALITY_CANARY=1 npm run eval:models:bootstrap:canary
MODEL_QUALITY_CANARY=1 npm run eval:models:bootstrap:e2e # isolated E2E-only diagnostic
npm run eval:models:audit-real # no model calls; verifies report, evidence, cleanup and hashes
```

The serial manifest allows one retry only for infrastructure failure, with 15-minute phase, 45-minute E2E, two-hour total, $2 phase, $8 E2E, and a user-approved $100 cumulative hard ceiling. Authenticated cost summaries retain exact or conservative participant/outer/judge attempts, accepted/rejected/current-run/cumulative totals, and warnings at $25/$50/$75. A row launches only when its complete frozen reservation fits below the cumulative ceiling. Only Pi-managed `openai-codex` authentication is copied into disposable homes; conflicting outer-model or credential-file overrides fail before reservation, authentication selection, provisioning, or launch. Connected runs collect ephemeral exact credential values, prove they do not survive in artifacts, handoffs, normalized results, reports, or evidence payloads, and pass those values to content-addressed evidence redaction without persisting them. Redacted evidence is retained for 90 days under the mode-`0700` private root `/Users/jason/work/projects/model-quality-evidence/ppe-001`. Raw transcripts and disposable workspaces are deleted after the selected artifact, strict judge record, deterministic evidence, telemetry, and provenance are redacted and stored.

The opt-in flag, exact config/manifest hashes, identities, family independence, routes, credentials, evidence root, limits, sparse rows, and Stage 7 sentinels are fail-closed. Model-free results are never substituted for I4 evidence, and bootstrap reports still cannot emit qualification or routing actions. The E2E adapter uses one disposable task/repository; each receiver must emit an independently parsed `CONSUMED_INBOUND` hash/path record bound to exact prior file content. Prelaunch prompt, fixture, scorer, tool and route assets are sealed before execution, while participant/outer/judge identities and settings derive from runtime/session events or sealed launch argv. Admission sequences/publications are persisted in every normalized slot.

`SpendLedger` content-addresses every cumulative state. It reserves the complete frozen row budget before a paid launch, records participant/outer/judge tokens, cost and wall time, conservatively charges incomplete/failed attempts, and can never lower imported spend. Spend and admission locks atomically record authenticated PID, process-start identity, nonce, and timestamp ownership. Stale recovery first hard-links the exact validated dead inode as a fencing marker; contenders must withdraw while that marker exists, so concurrent reclaimers cannot unlink a newly acquired live lock. A contender killed after linking a different candidate inode is distinguished from a live owner and safely refenced, so dead/PID-reused owners and interrupted admission journals recover on first restart while live owners are never removed. Concurrently live paid runs are not mistaken for crashes. Evidence indexes are themselves authenticated; `audit-real` joins exact participant provenance, admission state, report/config/manifest hashes, the pending-human record, credential-value scans available to the operator, and the content-addressed spend ledger.

**Current v3 status:** the authoritative serial run passed all six rows. Accepted current-run estimated cost is `$2.802016` (`$1.503493` participant, `$1.156283` outer, `$0.142240` judge). The authenticated conservative cumulative ledger is `$47.503104/$100`, including `$15.791287` imported history, `$5.711817` settled v3 entries, and `$26` failed reservations. The `$25` warning is active and `$50` is next. See `reports/2026-07-21-ppe-001-infrastructure-status.md` and the committed report for per-row/per-attempt details. `reports/rejected-real-canary-v2.json` remains explicitly rejected historical evidence and can never substitute for v3.

## PPE-002 boundary

PPE-002 may implement an independently reviewed golden incident policy through the injected interface and may manage private golden/oracle lifecycle. It cannot alter bootstrap identities, policy, logs, evidence, or reports. This directory does not implement golden authoring/approval, calibration, candidate comparison, profile qualification, or routing adoption.
