# PPE-001 infrastructure status — 2026-07-21

> **INFRASTRUCTURE_ONLY — NOT QUALIFICATION EVIDENCE**

## Outcome

I1–I4 pass. The authoritative v3 real canary completed all six frozen phase/E2E rows with one connected E2E task, four observed handoffs, exact participant/outer/judge binding, durable admission/evidence/spend joins, cleanup, and no qualification or routing output. PPE-001 remains ready/claimed and I5 remains pending independent VERIFY/REVIEW/CLOSE; PPE-002 remains blocked.

## Accepted evidence

- Source candidate used for the accepted run: local `47a7feb` lineage plus the frozen v3 configuration/manifest commits; final candidate commit is recorded after this report update.
- Config hash: `a0735215ef05c8cdee6000921d89e13a3eaed4eb7992ccf3792f344bbbfb960f`.
- Manifest hash: `4c54eee3d93f34790ec7a869fc41ed23977a6f36a594416990384adb54fa0c9a`.
- Report hash: `48fb4fc620adba73147c10578eefc8ad313577f2797b44a8ae960a463908cdc5`.
- Model-free report hash: `3411c53d504aba521625bd20f1ea7f52865ec210fac78d11c4983de1d379b929`.
- `6/6` PASS; reliability `1`; candidate failures `0`; infrastructure exhaustion `0`; tainted slots `0`; observed handoffs `4`.
- Accepted run tokens: input `310,598`, output `35,695`, cached `356,352`.
- Accepted run wall time: `1,149,811ms`.
- Evidence root `/Users/jason/work/projects/model-quality-evidence/ppe-001`, mode `0700`, 90-day retention; `218` authenticated objects/indexes audited.
- Raw transcripts, disposable repositories, Pi homes, extension shims, and raw benchmark artifacts were removed.

## Cost visibility

The user approved a `$100` cumulative hard ceiling rather than unlimited execution. Per-phase `$2`, E2E `$8`, timeout, credential, model, and retry limits remain unchanged. Warnings are emitted at `$25`, `$50`, and `$75`.

### Accepted current run

| Row | Participant | Outer | Judge | Total |
|---|---:|---:|---:|---:|
| IMPLEMENT | `$0.118519` | `$0.064991` | `$0.030710` | `$0.214220` |
| VERIFY | `$0.146452` | `$0.098968` | `$0.041560` | `$0.286980` |
| REVIEW | `$0.199339` | `$0.227655` | `$0.039350` | `$0.466344` |
| CLOSE | `$0.149867` | `$0.128305` | `$0` | `$0.278172` |
| RETRO | `$0.101406` | `$0.088735` | `$0.030620` | `$0.220761` |
| Connected E2E | `$0.787910` | `$0.547629` | `$0` | `$1.335539` |
| **Total** | **`$1.503493`** | **`$1.156283`** | **`$0.142240`** | **`$2.802016`** |

### Authenticated cumulative ledger

- Imported conservative pre-v3 spend: `$15.791287`.
- Settled/accepted v3 entries, including partial rows from rejected whole-run attempts: `$5.711817`.
- Rejected/failed v3 reservations: `$26.000000` (conservative; may exceed exact subscription-accounted usage where telemetry was unavailable).
- Active reservation: `$0`.
- **Conservative cumulative estimate: `$47.503104` / `$100`.**
- Triggered warning: `$25`; next warning: `$50`.
- The committed report contains all per-attempt participant/outer/judge telemetry plus accepted, rejected, current-run, imported, and cumulative totals.

## Passing gates

```text
npm run eval:models:validate       PASS — 6 items, 6 sparse rows, 17 sentinels
npm run eval:models:fake-full      PASS
npm run eval:models:audit          PASS
focused infrastructure tests       PASS
npm run eval:dsm-agents:validate   PASS
npm run verify                      PASS — exact default host discovery executed
real serial v3 canary               PASS — 6/6
npm run eval:models:audit-real     PASS — report/evidence/admission/ledger join
```

Exact no-local clean-clone reproduction of the final committed candidate passed install, validate, focused infrastructure tests, model-free audit, `audit-real`, default `npm run verify` with required host discovery, and clean-worktree checks without another model call.

Post-canary model-free security hardening additionally proves that connected artifacts/handoffs/report payloads fail closed on arbitrary exact runtime credential values, retained v3 evidence contains none of the currently available Pi-managed secrets, and conflicting outer-model/credential-file overrides fail before reservation, auth copy, provisioning, or launch. Spend preflight now requires the complete frozen row reservation. Spend and admission mutexes use atomically authenticated PID/process-start/nonce ownership plus exact-inode hard-link fencing. A late reclaimer cannot unlink a newly acquired live lock; a contender SIGKILLed after linking a different inode is safely refenced; dead/PID-reused owners recover on first restart; malformed ownership fails closed; and concurrently live paid runs remain active. Admission journals are authenticated and atomically published with fsynced temporary-file rename: deterministic kills during or immediately before publication leave only uncommitted temporaries that first restart discards, while malformed/hash-mismatched committed journals remain fail-closed. Rejected as well as held incident decisions durably reserve exact idempotency keys, with identical/conflicting retries proven across restart and concurrency. Deterministic spend/admission two-reclaimer, acquisition-kill, transaction-boundary, journal-publication, idempotency, and eight-process stress tests preserve mutual exclusion, admission state, and every reservation. These changes do not alter accepted v3 semantics, report/config/manifest hashes, or cumulative cost.

## Preserved boundaries

Stage 7 files/scenarios/reports remain sentinel-protected and unchanged. Bootstrap schema, runner, report, and adoption boundaries independently reject qualification. No golden-data governance, candidate qualification, profile comparison, routing/default, bundled-agent, or PPE-002 implementation changed. Failed attempts and the rejected v2 report remain retained as rejected infrastructure evidence and never substitute for frozen slots.
