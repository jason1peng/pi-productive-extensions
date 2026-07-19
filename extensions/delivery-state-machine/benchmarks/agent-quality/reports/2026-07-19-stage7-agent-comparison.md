# Stage 7 delivery-agent comparison — 2026-07-19

## Result

**Benchmark verdict: PASS_WITH_NON_BLOCKING_NOTES.**

The reviewed joined result contains 20/20 passing pilot trials and 60/60 passing full-benchmark trials. Both the packaged DSM agents and controlled builtin baselines passed every authoritative correctness, safety, artifact, behavior, mutation, Git, runtime-identity, cleanup, and redaction check in the valid joined evidence.

The DSM agents showed no measured quality advantage in this catalog and consumed about 35.5% more child cost than the builtins. Promotion remains a user decision. This report recommends keeping the `dsm.*` namespace; builtin shadowing was not evaluated.

## Reproducibility record

- Promptfoo: `0.121.19`, exact-pinned
- Model: `openai-codex/gpt-5.6-sol` for outer and child sessions
- Context: `fresh`
- Comparison mode: `controlled`
- Cache: disabled
- Concurrency: `1`
- Pilot repetitions: 2 per candidate for `IMP-01`, `VER-01`, `REV-01`, `CLO-01`, and `RET-01`
- Full repetitions: 3 per candidate for all ten scenarios
- Final all-scenario scorer commit: `b78a2e97ee9c7c2a6df4759a41709155432a6be2`
- Final CLO-01 contract commit: `7f3575e55210f1c9be2f92383440108866f24d4d`
- Final all-scenario eval: `eval-njl-2026-07-19T21:02:00`
- Final CLO-01 replacement eval: `eval-P0r-2026-07-19T23:03:24`
- Raw workspaces and transcripts: retained locally under ignored `artifacts/raw/`; not committed

The authoritative joined full result uses 54 rows from the final all-scenario eval and all six `CLO-01` replacement rows from the final contract eval. The authoritative joined pilot uses repetitions 0–1 for its five scenarios from those same final sources: 16 non-CLO rows plus four CLO replacement rows. All selected rows passed.

## Framework findings and invalidation history

Pilot/full execution exposed framework-contract defects before adoption:

1. Packaged agents without an explicit `thinking` frontmatter default could not be wrapped for controlled evaluation. The wrapper now inserts the frozen scenario thinking level when absent.
2. Authoritative provider/model identity and retained before/after Git and per-control evidence were strengthened during prerequisite review.
3. `CLO-01` now requires the existing current branch; branch creation/switching is prohibited and checked through command attempts plus before/after branch sets.
4. Prose substring checks produced false negatives despite correct structured evidence and deterministic controls. Prose wording no longer overrides exact structured hidden-outcome, behavior, mutation, and Git evidence.
5. `RET-02` accepts omission of excluded speculation as equivalent to keeping it non-blocking.
6. `REV-02` accepts a clean `PASS` that either records the excluded concern or records no meaningful residual concern.
7. The close fixture now names the supported boundary: invoke `gh pr create` exactly once and retain its returned stub URL. Help/version calls do not create PR records, and `glab`, bare `pr`, duplicate creates, and invalid URLs do not satisfy the contract.

Every scenario or scorer change invalidated the affected evidence. The global artifact-scoring change triggered a complete 60-trial rerun. The later CLO-only contract change invalidated and reran all six CLO-01 rows. No failed row was relabeled in place.

## Joined pilot

| Candidate family | Passed | Failed | Infrastructure |
|---|---:|---:|---:|
| DSM | 10 | 0 | 0 |
| Builtin | 10 | 0 | 0 |
| **Total** | **20** | **0** | **0** |

## Joined full benchmark

| Role | DSM | Builtin |
|---|---:|---:|
| IMPLEMENT | 6/6 | 6/6 |
| VERIFY | 6/6 | 6/6 |
| REVIEW | 6/6 | 6/6 |
| CLOSE | 6/6 | 6/6 |
| RETRO | 6/6 | 6/6 |
| **Total** | **30/30** | **30/30** |

One `RET-01 delegate` infrastructure failure was retried by the bounded provider and then passed. It was unscored and did not become a candidate loss. No joined row has unresolved infrastructure, identity, cleanup, mutation, or redaction failure.

## Usage

Usage is descriptive and did not alter correctness verdicts. Child totals include the final scored child attempts only.

| Candidate family | Input | Output | Cache read | Child cost | Average child cost/trial |
|---|---:|---:|---:|---:|---:|
| DSM | 507,359 | 101,286 | 855,552 | $6.003151 | $0.200105 |
| Builtin | 393,611 | 72,886 | 549,376 | $4.429323 | $0.147644 |

DSM child cost was approximately **35.5% higher** than builtin child cost across the joined controlled matrix.

Final scored outer-orchestrator cost was DSM `$2.683111` and builtin `$2.513593`. The builtin infrastructure retry incurred an additional `$0.105183` of outer cost, making total incurred builtin outer cost `$2.618776`; it remained excluded from candidate-quality scoring.

## Scenario manifest

| Scenario | Fixture | SHA-256 | Thinking | Effective tools |
|---|---|---|---|---|
| `CLO-01` | `v1` | `c4c2a4f00dc83980a4df4cb3f2e743b5425aa12e7b94d2cb0ab9774615c5f241` | `low` | `read, grep, find, ls, bash` |
| `CLO-02` | `v1` | `185a87609b37728132d418bac5e8e63896840886d52c2a6369cca3a07aa9f4e1` | `low` | `read, grep, find, ls, bash` |
| `IMP-01` | `v1` | `38ea7c73672849f4092ff7a7b11c180e23752243aa2f41b415771479ee5957db` | `high` | `read, grep, find, ls, bash` |
| `IMP-02` | `v1` | `0e0a03ae33e82e7df2c86c26ce40c3a3de82fc0eae6f13a268b6242c748e7550` | `high` | `read, grep, find, ls, bash` |
| `RET-01` | `v1` | `a706ed6b6a574a38352c709d8bcc6aced814ed811c15ffe17f744a7435b5f44a` | `high` | `read, grep, find, ls, bash` |
| `RET-02` | `v1` | `b9b9f398cf7835ae29710fee4981e6dfa5a59d80bde5184381ccafb5aac1a3f4` | `high` | `read, grep, find, ls, bash` |
| `REV-01` | `v1` | `e6ce572082a01129da987309bc189b37b2db2ba874005de336f0521f55d2241d` | `high` | `read, grep, find, ls, bash` |
| `REV-02` | `v1` | `2753fe5c952f712e9275c7bf8d1ce2c8b505cf2b626df448451f4303029d978d` | `high` | `read, grep, find, ls, bash` |
| `VER-01` | `v1` | `dea4acc6f34980e794b6b6651107faf26580c34d6224adf4adefb640fbf4403c` | `low` | `read, grep, find, ls, bash` |
| `VER-02` | `v1` | `b36473728ca7f6d1a5cb1095c5d66a3593f2af9a454432e16c01c220dbb34b4c` | `low` | `read, grep, find, ls, bash` |

## Decisions required

1. **Delivery defaults:** choose whether to promote `dsm.*` into the bundled delivery default profile. Evidence supports safety/correctness parity, but not a quality or efficiency advantage.
2. **Namespace:** retain `dsm.*` unless a separate general-purpose benchmark and explicit decision support builtin shadowing.

## Recommendation

- **Namespace:** retain `dsm.*`.
- **Delivery default:** retain the current default because the controlled benchmark found parity with higher DSM usage, unless delivery-specific policy ownership is judged valuable enough to accept the measured cost premium. Do not infer promotion automatically from the PASS verdict.
