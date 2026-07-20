# Stage 7 delivery-agent comparison — 2026-07-20

## Result

**Benchmark verdict: PASS_WITH_NON_BLOCKING_NOTES.**

After simplifying the DSM system prompts, the frozen pilot passed 20/20 and the full benchmark passed 60/60. DSM and builtin candidates each passed all 30 authoritative correctness, safety, artifact, behavior, mutation, Git, runtime-identity, cleanup, and redaction checks.

DSM retained no measured quality advantage. Its child cost was approximately 26.5% higher and mean trial duration approximately 7.4% longer than the builtins. This is materially better than the pre-simplification comparison, but still favors retaining the current defaults unless delivery-specific policy ownership is worth the remaining premium.

## Reproducibility record

- Promptfoo: `0.121.19`, exact-pinned
- Candidate commit: `08cfb3d802cbb7cff4993f92105e97616663094c`
- Model: `openai-codex/gpt-5.6-sol` for outer and child sessions
- Context: `fresh`
- Comparison mode: `controlled`
- Cache: disabled
- Concurrency: `1`
- Pilot eval: `eval-p7B-2026-07-20T02:39:06`
- Full eval: `eval-Bqp-2026-07-20T03:18:34`
- Pilot: 2 repetitions per candidate for `IMP-01`, `VER-01`, `REV-01`, `CLO-01`, and `RET-01`
- Full: 3 repetitions per candidate for all ten scenarios
- Raw workspaces and transcripts: retained locally under ignored `artifacts/raw/`; not committed

All 60 authoritative full rows were produced by one frozen candidate commit and scorer revision. No row was rescored or joined from an earlier prompt revision.

## Prompt simplification

The DSM prompts were reduced from 2,437 to 1,201 words across five agents (approximately 50.7%). The change:

- retained phase role, mutation/safety boundaries, methodology, supported-model finding discipline, escalation, and parent workflow ownership;
- removed duplicated runtime-owned verdict syntax, exact artifact headings, harness heading syntax, and detailed output checklists;
- changed `inheritSkills` from `true` to `false`, matching the controlled builtins and removing inherited-skill bias;
- kept dynamic task, state, invariants, exclusions, mutation policy, artifact path, verdicts, and output contract in the generated user message.

The benchmark therefore compares distinct system prompts while holding the generated user message, model, tools, thinking, context, tasks, and fixtures constant.

## Pilot

| Candidate family | Passed | Failed | Infrastructure |
|---|---:|---:|---:|
| DSM | 10 | 0 | 0 |
| Builtin | 10 | 0 | 0 |
| **Total** | **20** | **0** | **0** |

## Full benchmark

| Role | DSM | Builtin |
|---|---:|---:|
| IMPLEMENT | 6/6 | 6/6 |
| VERIFY | 6/6 | 6/6 |
| REVIEW | 6/6 | 6/6 |
| CLOSE | 6/6 | 6/6 |
| RETRO | 6/6 | 6/6 |
| **Total** | **30/30** | **30/30** |

Two builtin outer-orchestrator attempts (`RET-02 delegate` and `REV-01 reviewer`) failed infrastructure checks before child launch, were unscored, and passed on bounded retry. No authoritative row has unresolved infrastructure, identity, cleanup, mutation, or redaction failure.

## Child usage

Final scored child attempts only:

| Candidate family | Input | Output | Cache read | Cost | Average cost/trial |
|---|---:|---:|---:|---:|---:|
| DSM | 563,453 | 80,258 | 714,240 | $5.582125 | $0.186071 |
| Builtin | 403,267 | 72,000 | 473,600 | $4.413135 | $0.147105 |

DSM child cost was approximately **26.5% higher**. Final scored outer-orchestrator cost was DSM `$2.783951` and builtin `$2.662833`. The two unscored builtin infrastructure attempts incurred an additional `$0.300703`, making total incurred builtin outer cost `$2.963536`; this overhead does not alter candidate-quality scoring.

## Trial duration

Duration is `finishedAt - startedAt` for each final scored trial and includes outer launch plus child execution. P95 uses the lower-observation nearest-rank value. Provider latency remains a source of variance.

| Candidate family | Mean | Median | P95 | Sum of trial durations |
|---|---:|---:|---:|---:|
| DSM | 105.6s | 102.8s | 133.7s | 52.8 min |
| Builtin | 98.3s | 95.0s | 115.1s | 49.2 min |

DSM mean duration was approximately **7.4% longer**.

## Scenario manifest

| Scenario | Fixture SHA-256 | Thinking | Effective tools |
|---|---|---|---|
| `CLO-01` | `c4c2a4f00dc83980a4df4cb3f2e743b5425aa12e7b94d2cb0ab9774615c5f241` | `low` | `read, grep, find, ls, bash` |
| `CLO-02` | `185a87609b37728132d418bac5e8e63896840886d52c2a6369cca3a07aa9f4e1` | `low` | `read, grep, find, ls, bash` |
| `IMP-01` | `38ea7c73672849f4092ff7a7b11c180e23752243aa2f41b415771479ee5957db` | `high` | `read, grep, find, ls, bash` |
| `IMP-02` | `0e0a03ae33e82e7df2c86c26ce40c3a3de82fc0eae6f13a268b6242c748e7550` | `high` | `read, grep, find, ls, bash` |
| `RET-01` | `a706ed6b6a574a38352c709d8bcc6aced814ed811c15ffe17f744a7435b5f44a` | `high` | `read, grep, find, ls, bash` |
| `RET-02` | `b9b9f398cf7835ae29710fee4981e6dfa5a59d80bde5184381ccafb5aac1a3f4` | `high` | `read, grep, find, ls, bash` |
| `REV-01` | `e6ce572082a01129da987309bc189b37b2db2ba874005de336f0521f55d2241d` | `high` | `read, grep, find, ls, bash` |
| `REV-02` | `2753fe5c952f712e9275c7bf8d1ce2c8b505cf2b626df448451f4303029d978d` | `high` | `read, grep, find, ls, bash` |
| `VER-01` | `dea4acc6f34980e794b6b6651107faf26580c34d6224adf4adefb640fbf4403c` | `low` | `read, grep, find, ls, bash` |
| `VER-02` | `b36473728ca7f6d1a5cb1095c5d66a3593f2af9a454432e16c01c220dbb34b4c` | `low` | `read, grep, find, ls, bash` |

## Interpretation

The result does not show that agents need no task contract. Both families received a compact generated contract containing the task, accepted invariants, exclusions, mutation policy, controls, artifact/verdict requirements, and exact output path.

It shows that the builtin system prompts can satisfy this delivery catalog when given that contract. The additional DSM static specialization preserved parity but did not produce a measurable quality gain. Simplification reduced, but did not eliminate, DSM's usage and latency premium.

## Recorded decisions

1. **Delivery defaults:** retain the current builtin-based default profile. The deterministic comparison tied on quality while DSM remained more expensive and slower, and no blinded qualitative evaluation demonstrated a DSM advantage.
2. **Namespace:** retain `dsm.*` as an optional explicit profile. Do not shadow general-purpose builtin names without a separate general-purpose evaluation and explicit decision.
3. **User-scoped verifier:** retain `fresh-verifier` because the unchanged default profile still uses it.

## Conclusion

Builtins provide the better measured default value for the current delivery workflow. The simplified `dsm.*` agents remain available for users who prefer package-owned phase policy and accept the measured premium. A future blinded human or supplemental LLM-judge study may compare clarity, insight, and actionability, but it must not override deterministic safety failures.
