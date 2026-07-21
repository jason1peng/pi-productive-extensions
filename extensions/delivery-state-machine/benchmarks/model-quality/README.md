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

Normal CI and `npm run verify` remain model-free. Raw evidence and disposable workspaces stay under ignored `artifacts/` or a separately selected absolute durable evidence root.

## Bootstrap coverage

The manifest contains exactly six frozen rows: IMPLEMENT, VERIFY, REVIEW, CLOSE, RETRO, and one E2E handoff row. Canned tests cover deterministic failures, false results, unsupported blockers, infrastructure classification, retries/exhaustion, identity/judge collision, malformed evaluator output, human states, evidence/redaction failures, cleanup, handoff completeness, metrics, holds, quarantine, and both incident/publication linearization orders.

CLOSE rejects default judge admission. Other judge packs are tool-less data contracts containing only the accepted contract, anonymized eligible outputs, randomized order/nonce, deterministic eligibility summary, and rubric. They exclude identity, cost, latency, raw transcripts, and chain-of-thought. A judge cannot reverse a deterministic critical failure; a model-produced VERIFY/REVIEW blocker requires deterministic reproduction or affirmative hash-linked human confirmation.

## Incident and admission safety

`admission.ts` provides the PPE-001 synthetic policy injection seam. Only the allowlisted bootstrap incident service can create/escalate a persistent pending hold. It cannot clear, quarantine, or change lifecycle/admission state. Signed authorized humans alone can dismiss an unchanged-hash false positive or convert a pending hold to durable quarantine.

Selection, dispatch, result use, joins, and report publication share a per-item/version linearizable guard with incident holds. Hold-first publications become `TAINTED_OR_INVALIDATED`; publication-first holds durably taint all linked publications before acknowledgement. A write-ahead journal, monotonic sequence, idempotency keys, startup reconciliation, and fail-closed stale-hash behavior cover crash/retry/restart paths. Holds never auto-expire and frozen slots are never substituted.

## Opt-in real canaries

The approved immutable I4 configuration is frozen in `bootstrap/real-canary-config.json` and `bootstrap/real-canary-manifest.json`. It uses `openai-codex/gpt-5.6-sol` at low thinking for the participant and outer runtime, and the independent `openai-codex/gpt-5.5` family at high thinking for supplemental judging. It executes the existing builtin IMPLEMENT, VERIFY, two-reviewer REVIEW, CLOSE, and RETRO routes plus one complete E2E chain. CLOSE and E2E have no bootstrap judge.

```bash
MODEL_QUALITY_CANARY=1 npm run eval:models:bootstrap:canary
MODEL_QUALITY_CANARY=1 npm run eval:models:bootstrap:e2e # isolated E2E-only diagnostic
npm run eval:models:audit-real # no model calls; verifies report, evidence, cleanup and hashes
```

The serial manifest allows one retry only for infrastructure failure, with 15-minute phase, 45-minute E2E, two-hour total, $2 phase, $8 E2E, and $20 total ceilings. Only Pi-managed `openai-codex` authentication is copied into disposable homes; arbitrary environment credentials are not forwarded. Redacted content-addressed evidence is retained for 90 days under the mode-`0700` private root `/Users/jason/work/projects/model-quality-evidence/ppe-001`. Raw transcripts and disposable workspaces are deleted after the selected artifact, strict judge record, deterministic evidence, telemetry, and provenance are redacted and stored.

The opt-in flag, exact config/manifest hashes, identities, family independence, routes, credentials, evidence root, limits, sparse rows, and Stage 7 sentinels are fail-closed. Model-free results are never substituted for I4 evidence, and bootstrap reports still cannot emit qualification or routing actions. The E2E adapter uses one disposable task/repository with hash-linked repository-local handoffs; disconnected trials cannot pass. Effective identities/assets come from authoritative runtime/provision evidence, retry/spend limits are row-wide and cumulative, and `audit-real` retrieves every accepted reference plus the pending-human record through unique provenance-bound indexes.

## PPE-002 boundary

PPE-002 may implement an independently reviewed golden incident policy through the injected interface and may manage private golden/oracle lifecycle. It cannot alter bootstrap identities, policy, logs, evidence, or reports. This directory does not implement golden authoring/approval, calibration, candidate comparison, profile qualification, or routing adoption.
