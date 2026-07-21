# PPE-001 infrastructure status — 2026-07-21

> **INFRASTRUCTURE_ONLY — NOT QUALIFICATION EVIDENCE**

## Outcome

I1–I3 and the REVIEW #2 model-free repairs are complete. I4 v3 is **BLOCKED BY THE APPROVED CUMULATIVE COST CEILING**, so PPE-001 remains ready/claimed, I5 remains open, no PPE-002 handoff is issued, and no qualification, profile, or routing action is supported.

## Passing model-free evidence

- One integrated Stage 7-backed sparse runner; 17 frozen Stage 7 sentinels remain unchanged.
- Six immutable bootstrap rows with independent schema, runner, report, and adoption rejection.
- Prelaunch-sealed exact prompt/fixture/scorer/tool/route contracts; authoritative participant/outer/judge runtime/session/argv observation and valid-SHA tamper rejection.
- Connected E2E receivers must emit a parsed `CONSUMED_INBOUND` hash/path bound to exact prior file content; ignored, omitted, stale, fabricated, mismatched-task, and mismatched-repository handoffs fail.
- Fake and real selection, dispatch, result-use, join, and report publication use a persistent linearizable admission guard.
- A journaled evidence/admission coordinator retains evidence before publication or incident acknowledgement, fails closed on missing evidence, and reconciles crashes at every prepare/evidence/guard/ack boundary.
- Authenticated evidence indexes; exact provenance, report/config/manifest, admission and pending-human joins in `audit-real`.
- Content-addressed cumulative spend ledger with prelaunch reservation, complete participant/outer/judge token/cost/time records, conservative failed/crashed charges, startup reconciliation, and no-lowering invariant.
- Exact default `npm run verify` passes without host mutation or skipped discovery by using a disposable copy of host `pi-subagents` with the source lockfile's `typebox@1.1.38` peer.

```text
npm run eval:models:validate       PASS — 6 items, 6 sparse rows, 17 sentinels
npm run eval:models:fake-full      PASS
npm run eval:models:audit          PASS
focused infrastructure tests       PASS
npm run eval:dsm-agents:validate   PASS
npm run verify                      PASS — required host-discovery smoke executed
```

Model-free expected report hash: `3ce9a737890a2b8a79db8f57b246b65c6bf506b7d7ae4e7e2fe90719dac8b76f`.

## Immutable v3 inputs

- Config hash: `921802242890a36746ed6865179cb4a863424e8045aee9a0080ffabeb0a26529`.
- Manifest hash: `13965b1cf102cde4d4071d2c4c12d5854845262007ce7656703179642e8cf832`.
- Participant/outer: `openai-codex/gpt-5.6-sol`, low, fresh.
- Judge: independent `openai-codex/gpt-5.5`, high, fresh; disabled for CLOSE/E2E.
- Exact rows: IMPLEMENT, VERIFY, two-reviewer REVIEW, CLOSE, RETRO, and connected E2E.
- Evidence: `/Users/jason/work/projects/model-quality-evidence/ppe-001`, mode `0700`, 90 days.

## Cost-ceiling blocker

The pre-v3 conservative cumulative spend was `$15.791287`. The first v3 IMPLEMENT/judge row failed after paid execution because the Pi JSON stream did not emit a `thinking_level_change` event. The repaired adapter now binds thinking to sealed `--thinking` launch argv and binds the effective model to the runtime `model_change` event.

The automatic ledger retains exact observed participant telemetry (`$0.259642`) but, because failed judge telemetry is unobservable, correctly charges the full `$2` reserved row ceiling. Cumulative spend is therefore `$17.791287`, ledger state hash `667cbf77a2c826eb77d15b1460d59e8e801514fff13a291f7e4811ba5258a336`, leaving `$2.208713`. One complete v3 rerun is expected near the last complete run's `$2.65`, so no further paid call is allowed under the approved `$20` ceiling.

Required decision: approve a `$25` cumulative ceiling for one authoritative v3 rerun, or stop with PPE-001 blocked. No increase has been approved in this delivery attempt.

## Rejected evidence

- `reports/rejected-real-canary-v2.json` is retained as explicitly rejected history; it is not accepted I4 evidence.
- The failed v3 row and every prior rejected attempt remain content-addressed or conservatively imported in the authenticated ledger. Spend is never lowered and rejected attempts are never substituted into a frozen outcome slot.
- `npm run eval:models:audit-real` fails closed because no accepted v3 report/pending-human/ledger join exists.

## Scope and cleanup

No golden-data governance, model qualification, profile comparison, routing/default, bundled-agent, or PPE-002 implementation changed. Raw transcripts, disposable repositories, Pi homes, and extension shims are absent. Durable evidence contains only authenticated redacted objects/indexes and spend/admission journals.
