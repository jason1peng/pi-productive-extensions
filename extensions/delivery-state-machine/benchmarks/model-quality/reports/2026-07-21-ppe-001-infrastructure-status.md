# PPE-001 infrastructure status — 2026-07-21

> **INFRASTRUCTURE_ONLY — NOT QUALIFICATION EVIDENCE**

## Outcome

I1–I3 implementation and model-free evidence are complete. I4 real-runtime, complete E2E, and independent-judge canaries are **BLOCKED**, so PPE-001 is not complete, no PPE-002 acceptance handoff is issued, and no model, phase pairing, profile, or routing action is supported.

## Implemented contracts

- Existing Stage 7 agent-quality runtime remains the shared runtime/isolation foundation; its scenarios, core contracts, Promptfoo config, and published report are hash-sentinelled and unchanged.
- Six-row explicit sparse bootstrap manifest: IMPLEMENT, VERIFY, REVIEW, CLOSE, RETRO, and E2E.
- Immutable versioned dataset seam with permanent bootstrap non-qualification.
- Exact participant/judge/non-target-route settings, resource namespaces, cleanup and redaction fields.
- Phase-specific deterministic precedence and supplemental judge-pack contracts; CLOSE rejects default judging.
- Hash-linked human confirmation, rejection, pending, and abstention states; silence is not confirmation.
- Redacted content-addressed evidence with provenance, retention, retrieval, and unavailable/expired failure behavior.
- Joined quality/reliability/token/cost/latency/repair/handoff/amplification arithmetic.
- Injected bootstrap incident policy, narrow service authority, persistent holds, human-only quarantine/resolution, linearizable hold/publication guard, journal recovery, monotonic sequence, and no substitution.
- Four independent bootstrap qualification/adoption rejection boundaries.

## Model-free evidence

```text
npm run eval:models:validate       PASS — 6 items, 6 explicit rows, 17 Stage 7 sentinels
npm run eval:models:fake-full      PASS — deterministic expected infrastructure report reproduced
npm run eval:models:audit          PASS — report hash reproduced from clean-clone assets
npm run eval:dsm-agents:validate   PASS — 10 Stage 7 scenarios and Promptfoo config
npm run verify                     PASS — with documented host pi-subagents typebox peer available
```

Expected bootstrap report hash: `8054bf80cb976f0e15713a550687df0f4abe623a1102465da22fd28ae6c87312`.

The model-free suite includes both hold/publication orders at result-use, join, and report boundaries; stale sequence; journal recovery; idempotent retry; hold escalation; service/human authority; changed hashes; quarantine; missing evidence; redaction; judge injection/malformed output; identity collision/mismatch; sparse-manifest mutation/expansion/budget; outcome slots, bounded infrastructure exhaustion, denominators, false rates, CLOSE judge suppression, E2E handoffs, arithmetic, and adoption rejection.

## I4 blocker

No immutable real-canary manifest has been approved with all of:

- exact participant model/version and outer model/version;
- an independent exact judge model/version/family for every enabled judge adapter;
- credential allowlist and selected private durable evidence root;
- total/per-row cost ceiling, timeout, retry, and cleanup policy;
- complete real phase-adapter and single-task E2E row set.

`npm run eval:models:bootstrap:canary` and `npm run eval:models:bootstrap:e2e` therefore exit nonzero before any model call. Model-free fakes are not substituted for I4 evidence. The plan-hub PPE-001 record must remain active/not-done until this configuration is reviewed, the canaries pass, evidence is independently reproduced, and I5 review completes.

## Known environment prerequisite

The source package declares `typebox` as a peer. In this machine's host Pi installation, `~/.pi/agent/npm/node_modules/pi-subagents` did not initially have its `typebox/compile` peer resolvable. Full verification passed with a temporary validation-only link to the source checkout's exact lockfile-installed `typebox@1.1.38`, and that link was removed afterward. A second operator must provide the host peer normally rather than rely on that temporary validation setup.

## Deferred PPE-002 handoff

Schema and injected policy interfaces are available for review, but the accepted PPE-002 handoff artifact is intentionally withheld until I4 and I5 pass. PPE-002 must not activate golden-data work from this status report.
