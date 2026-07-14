# Delivery prompt construction

This guide explains how the delivery state machine constructs parent and child prompts, which parts users can override, and which artifact requirements remain enforced.

## Prompt surfaces

A runnable phase exposes three different instruction surfaces through `delivery_next`:

- `orchestratorInstruction` — parent-only instructions for launching the phase.
- `childPrompt` — the complete prompt passed to a single child.
- `reportInstruction` — parent-only instructions for reporting the child result.

For parallel phases, each `details.next.parallel[]` entry receives its own `childPrompt` plus an exact `artifact`/`output` path. The aggregate artifact remains parent/state-machine owned.

The `/deliver` bootstrap prompt is separate. It comes from `prompts/deliver.md` and instructs the parent how to drive the state machine; it is not part of a phase child prompt.

## Child prompt assembly order

For a single-child phase, the final prompt is assembled in this order:

```text
1. Static project-harness discovery instructions
2. Resolved project/worktree root
3. Resolved phase child prompt
   a. Built-in phase `## Child prompt`
   b. User/global `## Child prompt` override, when present
   c. Placeholder rendering
   d. Centrally generated phase artifact contract
4. Static common child workflow footer
```

For each child in a parallel phase, one more block is appended:

```text
5. Parallel-child identity and exact attempt-specific artifact path
```

Conceptually, the implementation is:

```ts
const resolvedPhasePrompt =
  render(resolvedChildPromptTemplate, context)
  + phaseArtifactContractMarkdown(phase);

const baseChildPrompt =
  PROJECT_HARNESS_PROMPT
  + projectHarnessRootContext(state)
  + resolvedPhasePrompt
  + CHILD_PROMPT_FOOTER;

const childPrompt = parallel
  ? baseChildPrompt + parallelChildInstruction
  : baseChildPrompt;
```

The real implementation is split between `phase-config.ts` and `index.ts`.

## Phase prompt resolution

Built-in phase prompts live at:

```text
extensions/delivery-state-machine/phases/<phase>.md
```

User/global overrides live at:

```text
~/.pi/agent/extensions/delivery-state-machine/phases/<phase>.md
```

The user file has higher precedence. Overrides are merged by section:

- `## Orchestrator instruction`
- `## Child prompt`

A user file may override one section and inherit the other from the built-in file. Project-local phase prompt overrides are not loaded.

The resolved templates support these child-prompt values:

- `{{task}}`
- `{{artifactGuidance}}`
- `{{verifyRound}}`
- `{{maxRepairRounds}}`
- `{{pendingIssueSummary}}`
- `{{pendingIssueInstruction}}`

An override controls where these values appear. For example, omitting `{{artifactGuidance}}` omits the general artifact guidance block from the overridden phase text. It does **not** remove the central phase artifact contract or reporting validation.

## Central phase artifact contract

`phase-contract.ts` is the source of truth for each phase's:

- artifact filename stem;
- required headings;
- allowed verdicts;
- parallel eligibility;
- parallel aggregate verdict precedence.

`phaseArtifactContractMarkdown(phase)` converts that contract into instructions and appends them after the resolved phase prompt. For example:

```md
Artifact contract for REVIEW (use these headings in this order):

    RESULT: PASS|PASS_WITH_NON_BLOCKING_NOTES|FAIL

    ## Summary
    ## Must-fix findings
    ## Non-blocking notes
    ## Evidence reviewed
    ## Risk checks
    ## Recommendation
```

A user/global phase prompt override cannot remove or replace this appended contract. It may add more instructions or headings, but the required headings and verdicts remain authoritative.

## What is configurable

| Prompt element | User phase override? | Enforcement |
|---|---:|---|
| Phase-specific child instructions | Yes | Prompt guidance |
| Parent orchestrator instruction | Yes | Parent guidance |
| Placeholder placement | Yes | Rendered into the overridden template |
| General `{{artifactGuidance}}` placement/presence | Yes | Some equivalent rules are still validated centrally |
| Required artifact headings | No | `PHASE_CONTRACTS` + `delivery_report` validation |
| Allowed phase verdicts | No | `PHASE_CONTRACTS` + `delivery_report` validation |
| Artifact filename/path | No | Planned by the state machine and validated exactly |
| Project-harness discovery prefix | No | Added centrally |
| Common child workflow footer | No | Added centrally |
| Parallel child identity/output path | No | Added centrally per child |
| Parent report instruction | No | Generated centrally from state/phase |
| Agent/model/thinking/context | Not in phase Markdown | Configured through `phase-launches.json` profiles |

Changing the required headings or verdict set requires a source change to `phase-contract.ts`; there is currently no user configuration override for `PHASE_CONTRACTS`.

## Enforcement at report time

Prompt instructions are not the only safeguard. `delivery_report` rejects a new report unless the artifact satisfies the planned contract.

The checks include:

1. The submitted artifact path exactly matches the planned path.
2. The path is contained in the run artifact directory.
3. The artifact is a non-empty regular file and does not escape through a symlink.
4. Its first line is a valid `RESULT: <verdict>` line.
5. The verdict is allowed for the current phase and agrees with the reported verdict.
6. Every required `##` heading appears with its exact name and in contract order.
7. Required project-harness compliance evidence is present for new artifacts.
8. Relative local Markdown links resolve to existing regular files.

Required headings do not need to be consecutive, so additional headings may be included. Additional headings cannot substitute for, rename, or reorder the required headings.

For parallel VERIFY or REVIEW, every child artifact is validated independently. The state machine then derives the conservative aggregate verdict and atomically regenerates the aggregate artifact.

## Parent prompt construction

The parent receives two phase-specific instruction fields:

- `orchestratorInstruction` starts from the built-in phase Markdown and can be replaced by the matching user/global section.
- `reportInstruction` is generated in `index.ts` and cannot be replaced through phase Markdown.

The parent must pass only the returned child prompt to the subagent. Parent launch/report instructions should not be copied into the child prompt.

## Example: user override

A minimal user override can change VERIFY behavior while retaining the built-in orchestrator instruction:

```md
---
phase: VERIFY
---

## Child prompt

Independently test the requested behavior using the repository's supported public interface.

Task:
{{task}}

{{artifactGuidance}}
```

The final child prompt still receives, outside this override:

- project-harness discovery instructions and the resolved root;
- the VERIFY verdict and required-heading contract;
- the common instruction to return evidence to the parent and not call `delivery_report`;
- parallel-child output instructions when VERIFY has multiple configured launches.

This separation allows users to customize phase behavior without weakening the state machine's artifact and transition contract.
