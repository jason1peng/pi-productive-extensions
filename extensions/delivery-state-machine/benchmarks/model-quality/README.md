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

```bash
MODEL_QUALITY_CANARY=1 \
MODEL_QUALITY_CANARY_PARTICIPANT_MODEL=<exact-provider/model/version> \
MODEL_QUALITY_CANARY_OUTER_MODEL=<exact-provider/model/version> \
MODEL_QUALITY_CANARY_JUDGE_MODEL=<independent-exact-provider/model/version> \
MODEL_QUALITY_CANARY_MAX_COST_USD=<reviewed-ceiling> \
MODEL_QUALITY_EVIDENCE_ROOT=<absolute-private-durable-root> \
npm run eval:models:bootstrap:canary
```

Real phase/E2E/judge canaries remain fail-closed until those identities, independence, credentials, retry/budget settings, and the immutable canary manifest are reviewed and frozen. Model-free results are never substituted for that I4 acceptance evidence. Missing configuration exits nonzero as infrastructure blocking, not model-quality failure.

## PPE-002 boundary

PPE-002 may implement an independently reviewed golden incident policy through the injected interface and may manage private golden/oracle lifecycle. It cannot alter bootstrap identities, policy, logs, evidence, or reports. This directory does not implement golden authoring/approval, calibration, candidate comparison, profile qualification, or routing adoption.
