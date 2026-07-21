# PPE-001 infrastructure status — 2026-07-21

> **INFRASTRUCTURE_ONLY — NOT QUALIFICATION EVIDENCE**

## Outcome

PPE-001 I1–I4 implementation evidence is complete. All model-free gates and the approved immutable real-runtime phase/E2E/judge canary passed. Independent delivery VERIFY and REVIEW remain the I5 acceptance authority, so this report does not mark PPE-001 done and cannot support a model, phase pairing, profile, or routing action.

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
npm run test                       PASS — with the documented host typebox peer available
```

Expected model-free bootstrap report hash: `8054bf80cb976f0e15713a550687df0f4abe623a1102465da22fd28ae6c87312`.

The model-free suite includes both hold/publication orders at result-use, join, and report boundaries; stale sequence; journal recovery; idempotent retry; hold escalation; service/human authority; changed hashes; quarantine; missing evidence; redaction; judge injection/malformed output; identity collision/mismatch; sparse-manifest mutation/expansion/budget; outcome slots, bounded infrastructure exhaustion, denominators, false rates, CLOSE judge suppression, E2E handoffs, arithmetic, and adoption rejection.

## Approved immutable I4 configuration

- Config: `bootstrap/real-canary-config.json`, hash `e77c65b0be3cc7528ab0cfaf92c23bee4cd9708e33b2d982cb7e63c753834d34`.
- Manifest: `bootstrap/real-canary-manifest.json`, hash `388cdf56b3f70da28e3bbf24ef1d2deeba77a76cad2c68ed6d9784ccd8779f78`.
- Participant and outer: `openai-codex/gpt-5.6-sol` at low thinking.
- Independent supplemental judge: `openai-codex/gpt-5.5` at high thinking.
- Builtin routes: worker; fresh-verifier; two reviewers; delegate CLOSE; delegate RETRO.
- Rows: five phase rows and one E2E IMPLEMENT→VERIFY→REVIEW(two reviewers)→CLOSE→RETRO chain.
- CLOSE and E2E bootstrap judging: disabled.
- Limits: one infrastructure retry, 15-minute phase, 45-minute E2E, two-hour total, $2 per phase, $8 E2E, $20 total.
- Credentials: Pi-managed `openai-codex` authentication only; no arbitrary environment credential forwarding.
- Evidence: mode-`0700` `/Users/jason/work/projects/model-quality-evidence/ppe-001`, 90-day retention.

## Real canary evidence

```text
MODEL_QUALITY_CANARY=1 npm run eval:models:bootstrap:canary  PASS
npm run eval:models:audit-real                              PASS
```

- Result: 6/6 PASS, zero candidate failures, zero exhausted infrastructure rows, zero tainted rows, reliability 1.0, and four required handoffs.
- Successful frozen-manifest execution cost: `$2.615338`, below every row ceiling and the `$20` total ceiling.
- Successful execution wall time: `967298ms`, below all frozen timeouts.
- Tokens: 273,092 input; 31,703 output; 334,336 cached.
- Real report: `reports/real-canary-result.json`, hash `1d2039f1ccb52f76a11daee3a25a8d3fb9925e230aa1e7a762cc64de6007b3bc`.
- Durable audit at implementation time: 12 content-addressed objects/indexes, including fail-closed harness-repair evidence and the accepted run; all retrieval hashes and retention records passed.
- Raw transcripts and disposable repositories/Pi homes were deleted. The ignored Stage 7 raw-artifact directory is empty.
- Judge records are strict tool-less JSON, blinded/order-frozen, independent by exact version/family, and supplemental only. No CLOSE/E2E bootstrap judge was invoked.
- Human record is `pending` for delivery I5; it cannot reverse deterministic evidence or silently confirm a model-produced blocker.

Several pre-acceptance harness integration attempts failed closed while adapting current Pi package loading and the frozen Stage 7 verifier label. Pre-model duplicate-extension failures made no participant call; later repair attempts were retained as redacted infrastructure evidence rather than scored or substituted. The accepted six-slot report contains only the final immutable-manifest execution.

## I5 gate

Independent VERIFY must reproduce the model-free and durable-evidence audits from the committed candidate, challenge the real report and cleanup evidence, and confirm the exact manifest/config and Stage 7 sentinels. Independent REVIEW must find no blocker. PPE-001 remains ready/claimed until those gates and source CLOSE complete; only then may planctl release/done and the PPE-002 handoff occur.

## Known environment prerequisite

The source package declares `typebox` as a peer. This machine's host Pi installation requires the lockfile-installed `typebox@1.1.38` to be resolvable by the user-scoped pi-subagents package. Verification and the real canary used a temporary validation-only link to that exact dependency and removed it afterward. A second operator must provide the host peer normally or reproduce the same temporary, cleanup-verified setup.
