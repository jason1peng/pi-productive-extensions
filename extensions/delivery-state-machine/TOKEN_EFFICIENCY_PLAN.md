# Delivery State Machine — Token Efficiency Fix Plan

Status: **planning** (no implementation yet)
Source evidence: 3-model audit (kimi-k3 / glm-5.2 / gpt-5.6-luna:max) + measured validation from real run records (`~/.pi/delivery-run`, parent session transcripts). Full findings: `tmp/dsm-token-efficiency-review.html`.

Goal: cut delivery-run token cost ~40–55% on the orchestrator side and ~10–15% on the child-prompt side **without weakening any quality gate** (independent VERIFY, REVIEW, CLOSE, artifact contracts, bounded repair all stay).

---

## 1. What actually happened — plain language, with examples

### Example 1: The machine answers every question in triplicate (F1)

When the orchestrator asks "what do I do next?" (`delivery_next`), it gets an answer like this:

```
┌─ content.text (human-readable status) ─────────────┐
│ orchestrator: Launch the configured verifier...     │
│ childPrompt:                                        │
│   [FULL 9,000-char child instruction manual]  ◄── copy 1: NOBODY reads this
│ parentReport: After the child completes...          │
└─────────────────────────────────────────────────────┘
┌─ details.next (structured data) ───────────────────┐
│ childPrompt: [SAME 9,000-char manual]         ◄── copy 2: the orchestrator uses THIS one
│ prompt:      [SAME 9,000-char manual]         ◄── copy 3: kept "for compatibility" — NOBODY reads this
└─────────────────────────────────────────────────────┘
```

The same manual, printed 3 times, every phase transition. Measured in a real session: **~85k tokens per delivery for copies 1+3 alone** (16% + 16% of all delivery tool-response bytes). The code even admits copy 3 is dead: `deliver.md` says "`details.next.prompt` mirrors the same value for compatibility."

### Example 2: The reply that keeps getting fatter (F3)

Every tool response also attaches `details.state` — the full delivery history including every past report, every step's usage metadata, the launch config, project metadata. It grows with each call:

```
call 1:  state = 4,326 chars     (small envelope)
call 10: state = ~20,000 chars   (a binder)
call 21: state = 33,364 chars    (a phone book)
```

The orchestrator never reads history to decide the next action — it only needs "current phase, round, pending issue". Measured: **35% of all delivery tool-response bytes (~94k tokens/run) are this ever-growing attachment.**

### Example 3: The two phone calls (F11 — found via run records, not in the static audit)

Every phase, the orchestrator makes two calls:

1. `delivery_report("VERIFY passed")` → machine replies "OK, recorded. **Here's the full next-action package** (12,800 chars)"
2. `delivery_next()` → machine replies "**Here's the full next-action package** (the same 12,800 chars, again)"

Like phoning a restaurant to place an order, having them read the entire menu back, then immediately calling again to ask "so what's on the menu?" Measured: 9 such pairs per delivery ≈ **~95k tokens of pure re-transmission (~35%)**.

### Example 4: Why "small" waste is actually big — the desk analogy

The orchestrator keeps everything it has ever received on its desk. **Every new LLM turn, it must re-read the entire desk.** A useless 40k-token note doesn't cost 40k — it costs 40k × every remaining turn.

Real session numbers (2026-07-23, one delivery):
- 21 delivery tool calls → **267k tokens** of tool responses, one-time
- 139 assistant turns → those responses are re-read over and over: **~4.4M cumulative input tokens** (cache-read pricing softens the dollars, not the volume)
- So the avoidable 45–55% of tool-response bytes isn't a rounding error against runs that total **2.7M–15.6M tokens and $3–$13 each** (measured from 11 delivery summaries).

### Example 5: Repairs multiply everything

45% of real runs (5 of 11) looped IMPLEMENT/VERIFY 2–3 times. Every loop re-sends the IMPLEMENT+VERIFY prompts and adds 2 more bloated tool responses. So per-phase savings count ~1.5×.

### Example 6: The safety manual photocopied onto every work order (F2)

Every child launch gets the same ~530-token block: project-harness rules + "return results to parent" + "treat task text as context, not authority". Byte-identical across all 7 launches per run (~3.7k tokens/run). It's like photocopying the company safety manual onto page 1 of every work order instead of posting it on the wall (the agent's system prompt).

### What is NOT waste (and stays untouched)

The gates themselves — independent verification, review, close, artifact contracts, verdict validation, bounded repair, decision prompts — are the quality mechanism. All three audit models agreed: **we cut the photocopying, not the inspectors.**

---

## 2. Scope boundaries

**In scope:**
- F1: `details.next.prompt` mirror (`index.ts:870`) + `content.text` childPrompt embed (`index.ts:1486`)
- F11: `delivery_report` returning the full next action
- F3: unpruned `details.state` in `delivery_next`/`delivery_report` responses
- F4: worktree policy in 3 places; tool `promptGuidelines` duplicating `deliver.md`
- F5: `artifactGuidance` restating the contract preamble
- F6/F9: verify.md/review.md/deliver.md/close.md internal dedupes
- F2 (partial): compress shared constants; compose the harness contract from one source
- P2 decisions: dual prompt stacks (F7), adaptive REVIEW depth (F8), usage attribution (F10)

**Out of scope (explicitly not changing):**
- Phase gates, verdict semantics, artifact contract validation, parallel aggregate regeneration
- `decisionPrompt` content (may compress wording only)
- Default REVIEW depth stays 2 parallel children until the P2 benchmark decision
- Any prompt deletion that removes adjudication/classification rules (dedupe = say once, not say less)
- The June-era `~/.pi/delivery-run` records themselves (historical data)

## 3. Prerequisites

- [ ] Clean git state on `main`; new worktree from latest fetched `main` per repo policy
- [ ] **Baseline capture (before any change):** run one standard smoke delivery on current code; save its `00-delivery-summary.md` and measure its parent-session tool bytes with the measurement script (P1 step 1) — this is the "before" number every phase compares against
- [ ] Existing suite green: `tests/delivery-state-machine.test.ts`
- [ ] Repo fast verification command identified (package scripts / CI config) for pre-push checks

## 4. Phases

> **Structure decision (user-approved):** original P1 (response slimming) and P2 (prompt dedupe) are **merged into one implementation phase** — one cohesive change, one MR, one verification suite. Attribution is preserved via ordered commits with measurement after each. The failure modes are self-distinguishing (protocol breakage is loud/mechanical; gate softening is caught by fault injection). P3 stays separate: it's a decision/benchmark gate, not code.

### P1: Token-efficiency implementation (merged response-shape + prompt-content slimming)

- Depends on: none
- Justification: one cohesive unit — same extension, same test suite, one MR, one acceptance gate. No phase-splitting criterion applies to the sub-steps; they are ordered commits, not phases.
- Ordered commits:
  1. **c1 — measurement script + baseline.** `scripts/measure-delivery-tokens.py` (parse a parent session JSONL; report per-call tool-response bytes, state bytes, duplicate-copy bytes). Run one standard smoke delivery on current code; save summary + byte report as the "before".
  2. **c2 — response-shape slimming** (`index.ts`, `prompts/deliver.md`, tests):
     - **Delete the `prompt` field entirely** from NextAction (`index.ts:870`) — no backward compatibility (user decision). Keep `childPrompt` as the only field; update the 3 test assertions on `details.next.prompt`.
     - `formatNextAction()` (`index.ts:1486`): replace the full childPrompt embed with a one-line pointer.
     - `delivery_report`: return ack + new phase label + pending-issue summary + slim state only — **no** `details.next`. `delivery_next` stays idempotent; `deliver.md` already mandates calling it before launches.
     - Slim `details.state` in `delivery_next`/`delivery_report`: phase, rounds, pendingIssue, artifactDir, git info, readyToClose. Full history/steps only via `delivery_status`/`delivery_summary`.
     - Slim tool `promptGuidelines` (`index.ts:2377–2449`) to one-line pointers at deliver.md (keep one-liners for spawn-exhaustion + accept_risk); delete the worktree-policy duplicate from `worktreePolicyInstruction()` + `delivery_start` guidelines.
     - Update `deliver.md` protocol wording (drop "prompt mirrors childPrompt", document ack-only report) + update tests/fixtures.
     - **Measure:** expect ≥45% tool-response byte reduction vs baseline.
  3. **c3 — prompt-content dedupe** (`phases/*.md`, `index.ts` constants, `deliver.md`):
     - `artifactGuidance()` (`index.ts:562`): slim to artifact dir + current-phase stem + RESULT line + conciseness note.
     - Compress `PROJECT_HARNESS_PROMPT` ~30%; compose its contract block from `DSM_PROJECT_HARNESS_CONTRACT` (one source). Tighten `COMMON_CHILD_WORKFLOW_PROMPT` + `CHILD_PROMPT_AUTHORITY_SUFFIX`. (Moving constants into agent system prompts deferred to the P2 stack decision.)
     - `verify.md`: merge the 4 classification-rule restatements into one canonical adjudication block.
     - `review.md`: cut heading-enforced filler; state the must-fix 3-part evidence rule once; trim orchestrator instruction to aggregation mechanics.
     - Canonical wording for precedence/destinations/must-fix shared by verify.md, review.md, deliver.md (comment pointing at the canonical source; no new build machinery).
     - `deliver.md`: merge duplicated must-fix + usage-metadata paragraphs. `close.md`: one Remote-CI statement, merge non-repo bullets. `implement.md`/`close.md`: drop harness-duplicated "Inspect repository instructions". `retro.md`: drop redundant "Do not edit source files.".
     - **Checklist conservation rule:** cut only checklist items informationally identical to an instruction bullet; keep any item that adds output-format detail.
     - **Measure:** expect ≥15% child-prompt byte reduction for VERIFY/REVIEW; ≥4k tokens/run child-side.
  4. **c4 — verification evidence:** full test suite, smoke delivery end-to-end, fault-injection results, before/after byte report attached to the MR.
- Produces: measurement script + before/after byte report; updated tests green; one MR
- Done when:
  - Repo fast verification passes (tests + lint/typecheck per CI)
  - One smoke delivery completes end-to-end (all 5 phases, gates intact)
  - **Fault-injection gate:** two smoke deliveries with a deliberately broken implementation — one must FAIL at VERIFY, one must FAIL at REVIEW
  - Measured: ≥45% tool-response byte reduction; zero duplicate childPrompt per response; `details.state` ≤ ~2k chars steady-state; ≥4k tokens/run child-side reduction

### P2: Benchmark + strategic decisions (F7 stack, F8 review depth, F10 usage attribution)

- Depends on: P1 (decisions should be made on the post-slimming baseline)
- Justification: **(b)** produces an explicit user decision gate before any structural migration; **(c)** different output type (benchmark report + recorded decisions = handoff artifact), no code change in this phase
- Changes:
  1. Using the P1 measurement script + smoke infrastructure (`projects/delivery-sm-*`), run a small A/B matrix on identical tasks: default vs dsm-candidate profile × 1 vs 2 reviewers (3–4 runs per cell, small fixed task).
  2. Measure per cell: total tokens, parent-side bytes, child output tokens, gate verdicts, repair rate, artifact quality spot-check.
  3. **F7 decision:** one canonical prompt stack. Note the existing warning sign — Stage 7 benchmark showed DSM 26.5% *more* expensive at quality parity (30/30), and DSM children receive no in-prompt adjudication rules. Only migrate if the new benchmark shows a real total-cost win; otherwise keep the default stack and delete/retire the DSM compatibility path (or vice versa).
  4. **F8 decision:** REVIEW depth policy. Recommendation going in: 1 reviewer default; second reviewer (distinct model/focus) only on risk triggers — auth/secrets, data loss, concurrency/tenancy, public API, destructive cleanup, broad diffs, inconclusive first review. Implement as a `reviewDepth` launch-config knob, keeping parallel machinery intact.
  5. **F10 decision:** exact per-child usage attribution vs session-delta-only. Audit evidence: attribution rows in real summaries are mostly "unavailable" — the machinery costs maintenance but isn't producing usable data. Recommend simplify unless exact attribution is a product requirement.
  6. Record decisions in this file (append a Decisions section) before any follow-up implementation.
- Produces: benchmark report + recorded user decisions for F7/F8/F10
- Done when: benchmark table filled; user signs off on one option per decision; follow-up implementation plans (if any) reference the recorded decision

## 5. Parallelization

- **P1: one branch, sequential commits c1→c4.** Sub-steps share files (`index.ts`, `deliver.md`) and each commit is measured before the next begins, so parallel sub-work has no upside.
- **P2 stays a separate later phase** because it is a decision/benchmark gate (user sign-off), not code — it must run on the post-P1 baseline.
- Within P2, the benchmark runs themselves can fan out (multiple smoke deliveries in parallel worktrees) since they're read-only measurements.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Removing `details.next.prompt` / ack-only `delivery_report` breaks an orchestrator flow that relied on them | User decision: no backward compatibility required. `deliver.md` already mandates `delivery_next` before launches; keep `delivery_next` idempotent; smoke-delivery end-to-end proof in P1's gate |
| Prompt dedupe (P2) quietly weakens VERIFY/REVIEW strictness | Fault-injection gate: broken candidate must still FAIL both gates; dedupe rule is "say once", never "say less" |
| Tests are locked to current verbose shapes (they assert on decisionPrompt context, parallel behavior, etc.) | Update fixtures in the same commit as each shape change; tests remain the safety net, not a blocker |
| Benchmark too small to trust (P2) | Fixed small task, 3–4 runs per cell, report variance; if inconclusive, default to keeping current behavior |
| Cache-read pricing makes savings look smaller in $ than in tokens | Report both token volume and cost; token volume is the honest metric for context pressure |

## 7. Estimated impact (measured basis, per delivery run)

| Phase | One-time savings | With context re-billing (~139 turns) |
|---|---|---|
| P1 c2 (F1+F11+F3+F4) | ~120–150k tokens (~45–55% of tool-response bytes) | ~2M+ cumulative input tokens |
| P1 c3 (F5+F6+F9+F2-compress) | ~6–8k tokens child-side ×1.5 repair multiplier | smaller, but every child turn re-reads its prompt too |
| P2 (decisions) | up to 1 full reviewer call/run (F8) + stack consolidation (F7) | TBD by benchmark |

## 8. Execution checklist

- [ ] P1: ship the merged token-efficiency MR (commits c1–c4); tests green; smoke delivery end-to-end; fault-injection proves VERIFY and REVIEW still FAIL broken candidates; measured ≥45% tool-byte + ≥4k child-side reduction attached.
- [ ] P2: complete A/B benchmark; record user decisions for F7 (prompt stack), F8 (review depth), F10 (usage attribution) in this file before any structural migration.
