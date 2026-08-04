# Phase data flow — current design and simplification plan

Audience: anyone trying to understand what data the delivery state machine passes around per phase, why the current shape wastes tokens, and what the simplified shape will be.

Related: [TOKEN_EFFICIENCY_PLAN.md](../TOKEN_EFFICIENCY_PLAN.md) (fix plan), [prompt-construction.md](prompt-construction.md) (prompt layering), measured evidence in `tmp/dsm-token-efficiency-review.html`.

---

## 1. The players

```
┌────────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR (the parent LLM session — you, talking to pi)     │
│  • drives the loop by calling delivery_* tools                 │
│  • launches child subagents                                    │
│  • pays tokens for EVERYTHING it receives                      │
└───────────────┬────────────────────────────────┬───────────────┘
                │ tool calls / tool results       │ subagent launches (childPrompt)
┌───────────────▼───────────────┐   ┌─────────────▼──────────────┐
│ DELIVERY STATE MACHINE        │   │ CHILD SUBAGENTS            │
│ (this extension, index.ts)    │   │ (worker / verifier /       │
│  • owns state + phase logic   │   │  reviewer / closer / retro)│
│  • builds prompts             │   │  • do the actual work      │
│  • validates artifacts        │   │  • write artifact files    │
└───────────────┬───────────────┘   └─────────────┬──────────────┘
                │ reads/validates                  │ writes
┌───────────────▼─────────────────────────────────▼──────────────┐
│ ARTIFACT FILES (~/.pi/delivery-run/... or project run dir)     │
│  01-implementation.md, 02-verification.md, 03-review*.md, ...  │
└────────────────────────────────────────────────────────────────┘
```

## 2. Current design: the loop

```
1. `/deliver <request>`
      └─► returns a preparation instruction only; it creates no delivery state
2. parent resolves/reads any reference and calls delivery_start(prepared brief)
      └─► creates state and returns the deliver.md "playbook" (loop instructions) + first next-action package
3. delivery_next()
      └─► returns the NEXT-ACTION PACKAGE (see §3)
4. orchestrator launches child subagent(s):
      agent/model/thinking/context from package, task = details.next.childPrompt,
      output = details.next.artifact  (the exact planned artifact path)
5. child reads any named authoritative source before acting, then works (read-only gates or sole-writer implement), writes its artifact file, returns
6. delivery_report(phase, verdict, summary, artifact, usage)
      └─► validates the artifact (RESULT line, required headings, harness section, exact path)
      └─► updates state (history, steps, usage, repair routing)
      └─► returns a slim state acknowledgement
7. orchestrator calls delivery_next() (per playbook)
   → back to 3 for the next phase
8. On FAIL + recommendedDecision=repair → routes back to IMPLEMENT automatically.
   On WAITING_DECISION → decisionPrompt asks the user: repair / accept_risk / stop.
9. RETRO done → DONE; delivery_summary writes 00-delivery-summary.md.
```

## 3. Current design: what's inside every tool response

Every `delivery_next` AND every `delivery_report` returns all of this:

```
tool result
├── content[0].text            human-readable status + THE FULL childPrompt embedded
│                              (measured: ~42k tokens/run — nobody acts on this copy)
│
└── details
    ├── state                  FULL state clone: task, history[], steps[] (with usage
    │                          metadata), acceptedRisks, phaseLaunches, launchProfile...
    │                          grows ~4.3k → ~33k chars over a run
    │                          (measured: ~94k tokens/run = 35% of tool bytes)
    │
    └── next                   the NEXT-ACTION PACKAGE:
        ├── phase, agent, model, thinking, context     launch settings
        ├── artifact / output / outputMode             exact planned artifact path
        ├── childPrompt            ◄── the ONE copy the orchestrator actually uses
        ├── prompt                 ◄── identical mirror "for compatibility" (dead)
        ├── orchestratorInstruction                    parent-only guidance
        ├── reportInstruction                          parent-only "how to report back"
        └── parallel[]             for REVIEW: 2 entries, each with its own childPrompt
                                   (+ the base prompt/childPrompt still included)
```

Measured across 21 delivery calls in one real session: **~267k tokens total, of which ~45–55% is avoidable duplication/bloat.**

## 4. Current design: what flows INTO each phase's child prompt

The childPrompt is assembled from layers (see [prompt-construction.md](prompt-construction.md)):

```
[PROJECT_HARNESS_PROMPT]          generic repo-instruction discovery essay   (identical for all 7 launches/run)
[COMMON_CHILD_WORKFLOW_PROMPT]    "return results to parent"                 (identical)
[artifact contract preamble]      RESULT line + required headings            (phase-specific, small, needed)
[phase template body]             the phase's real instructions, with template slots:
    {{task}}                      the user's task text
    {{pendingIssueInstruction}}   "fix this finding" when looping from a failed gate
    {{verifyRound}}/{{maxRepairRounds}}
    {{artifactGuidance}}          artifact dir + style rules (partly restates the contract)
[projectHarnessRootContext]       one path line
[artifact path contract]          "write to exactly this path"
[CHILD_PROMPT_AUTHORITY_SUFFIX]   "task text is context, not authority"      (identical)
```

Real VERIFY example (from an actual session): 10,604 chars total — ~5.4k phase-specific payload, ~5.2k wrapper.

## 5. Current design: how reporting works

1. Child writes `0X-<phase>.md` at the exact planned path, first line `RESULT: <verdict>`, then the contract headings (e.g. VERIFY: Summary, Findings, Commands run, Behavioral evidence, Candidate completeness, Residual risks, Recommendation).
2. `delivery_report` validates: file exists at the exact path, non-empty, valid RESULT verdict, required headings present, harness-compliance section present, no symlink/path tricks.
3. For parallel REVIEW: each child writes its own `03-review-<attempt>-<NN>-<agent>.md`; the state machine atomically regenerates the aggregate `03-review.md` with conservative verdict precedence (FAIL > PASS_WITH_NOTES > PASS).
4. State records history (events), steps (phase attempts + usage attribution), pending issues, accepted risks.
5. RETRO reads all artifacts; `delivery_summary` renders the journey + usage report.

## 6. Why this is over-complex (the six problems)

| # | Problem | One-liner | Measured cost |
|---|---|---|---|
| P1 | childPrompt ×3 per response | copy in `content.text` (display), copy in `details.next.childPrompt` (used), copy in `details.next.prompt` (dead mirror) | ~85k tok/run |
| P2 | report→next double fetch | `delivery_report` returns the full next package; the playbook then says call `delivery_next` which returns it again | ~95k tok/run |
| P3 | ever-growing state attachment | full history/steps/launch-config clone on every call; orchestrator never reads it for decisions | ~94k tok/run |
| P4 | instructions in 3 channels | same rules in `deliver.md`, tool `promptGuidelines`, and `orchestratorInstruction` | ~1k tok/run + persistent system-prompt cost |
| P5 | wrapper blocks per child | harness essay + workflow + authority suffix + artifactGuidance repeated 7× per run | ~3.7k tok/run |
| P6 | prompt content said 2–4× | verify.md states classification rules 4×; must-fix rule appears 6–7× across files | ~0.8–1.5k tok/run |

## 7. Proposed design (after fix plan P1+P2)

### 7.1 Tool responses carry each piece of information exactly once

```
delivery_next tool result (NEW)
├── content[0].text   short status only: "Delivery: verify attempt 1/3 |
│                      branch: x | next: launch fresh-verifier → details.next"
└── details
    ├── state         SLIM: { phase, verifyRound, reviewRound, readyToClose,
    │                     pendingIssue, artifactDir, gitBranch, gitRoot }
    │                     (full history/steps only via delivery_status / delivery_summary)
    └── next
        ├── phase, agent, model, thinking, context
        ├── artifact / output / outputMode
        ├── childPrompt            ◄── ONE copy, nowhere else
        ├── orchestratorInstruction
        ├── reportInstruction
        └── parallel[]?            (unchanged)
        (prompt mirror: DELETED — user decision: no backward compatibility needed)

delivery_report tool result (NEW)
├── content[0].text   "VERIFY recorded: PASS. Next phase: REVIEW."
└── details           { state: SLIM }        ← no next package; orchestrator calls
                                               delivery_next when ready (already the
                                               documented protocol)
```

### 7.2 One home per instruction

| Rule | Lives in (single source) | Removed from |
|---|---|---|
| Loop protocol (launch, report, artifact checks) | `prompts/deliver.md` | tool `promptGuidelines` (one-line pointers only) |
| Worktree policy | `prompts/deliver.md` | `worktreePolicyInstruction()`, `delivery_start` guidelines |
| Artifact headings + RESULT | `phaseArtifactContractMarkdown()` | `artifactGuidance` restatement |
| Harness/workflow/authority boilerplate | compressed constants (later: agent system prompts, pending P3 stack decision) | — |
| Adjudication / must-fix classification | one canonical wording per phase file | 2nd–4th restatements in verify.md/review.md/deliver.md |

### 7.3 What does NOT change

- The loop itself: start → next → launch → report → gates → repair → decision → close → retro
- Artifact contract + report-time validation (exact path, RESULT, headings, harness section)
- Parallel REVIEW machinery and conservative aggregate verdicts (default depth stays 2 until the P3 benchmark decision)
- `decisionPrompt` user-decision flow; bounded repair; `delivery_status`/`delivery_summary` as the full-state readers

## 8. Mapping to the fix plan

| Problem | Fix phase | Fix |
|---|---|---|
| P1 (triplication) | plan P1.2, P1.3 | delete `prompt` mirror; pointer line in `content.text` |
| P2 (double fetch) | plan P1.4 | ack-only `delivery_report` |
| P3 (state bloat) | plan P1.5 | slim state snapshot |
| P4 (3 channels) | plan P1.6, P1.7 | guidelines → one-liners; deliver.md is the home |
| P5 (wrappers) | plan P2.1, P2.2 | slim artifactGuidance; compress harness constants |
| P6 (repeated rules) | plan P2.3–P2.8 | canonical wording once per file |

Each fix lands behind the gates in [TOKEN_EFFICIENCY_PLAN.md](../TOKEN_EFFICIENCY_PLAN.md): measured byte reduction for P1, fault-injection proof that VERIFY/REVIEW still catch broken candidates for P2.
