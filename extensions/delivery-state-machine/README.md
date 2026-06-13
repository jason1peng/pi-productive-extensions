# delivery-state-machine

Pi extension for parent-controlled delivery orchestration.

## Commands

- `/deliver <task>` — start the state machine and prompt the parent agent to orchestrate subagents.
- `/delivery-status` — show current state.
- `/delivery-summary` — show phase execution counts and session/subagent usage summary.
- `/delivery-reset` — reset to idle.

## Tools

- `delivery_start` — start from an agent turn.
- `delivery_next` — get the next required state/action, launch settings, and subagent prompt.
- `delivery_report` — report a completed phase and advance the state machine.
- `delivery_decide` — apply a parent/user decision for a pending blocker.
- `delivery_status` — inspect state.
- `delivery_summary` — summarize phase counts and session/subagent usage.
- `delivery_reset` — reset state.

## Setup

The `VERIFY` phase launches a user-scoped subagent named `fresh-verifier`. From this extension directory, install the bundled agent before using `/deliver`:

```bash
mkdir -p ~/.pi/agent/agents
cp agents/fresh-verifier.md ~/.pi/agent/agents/fresh-verifier.md
rm -f ~/.agents/fresh-verifier.md # remove legacy duplicate if present
```

From the top-level `pi-productive-extensions` repo, the copy command is:

```bash
cp extensions/delivery-state-machine/agents/fresh-verifier.md ~/.pi/agent/agents/fresh-verifier.md
```

The bundled verifier is instructed to be read-only for project/source files. It can run validation commands and write configured verification artifacts, but it should not edit the candidate diff or run destructive git/filesystem commands.

## States

`IMPLEMENT -> VERIFY -> REVIEW -> CLOSE -> RETRO -> DONE`

For new repository tasks, implementation should happen in a dedicated git worktree created from latest `main`, unless the delivery is continuing the same task or amending its requirement. Non-git/non-repo tasks should record why the worktree policy is not applicable. The delivery status line includes the current working branch when the current cwd is inside a git worktree.

`VERIFY` or `REVIEW` failures that are still within the original task or accepted plan should be reported with `recommendedDecision: repair`; the machine then routes back to `IMPLEMENT` automatically with the pending issue attached. `IMPLEMENT` is the only writer phase: it can perform the original task, address verifier findings, or fix accepted review blockers.

Failures move to `WAITING_DECISION` only when repair would change scope, conflict with the plan, require product judgment, exceed max repair rounds, or needs an explicit parent/user choice:

- `repair`
- `stop`
- `accept_risk`
- `continue`
- `defer`

Repair loops are bounded by `maxRepairRounds`.

## Guards

While an active delivery is not in `CLOSE`/`RETRO`/`DONE`, the extension blocks bash commands that create/push PR/MR branches:

- `git push`
- `glab mr create`
- `gh pr create`

## Artifact checklists

Delivery state-machine tools are hardcoded in `index.ts` and are intended for the parent/orchestrator session:

- `delivery_start`
- `delivery_next`
- `delivery_report`
- `delivery_decide`
- `delivery_status`
- `delivery_reset`

The `/deliver` bootstrap prompt lives in `prompts/deliver.md` so parent/orchestrator instructions are easy to review and edit. It supports placeholders such as `{{task}}` and `{{artifactDir}}`.

Phase setup lives in `phases/*.md`, similar to pi agent-style config files. Each runnable phase markdown file defines its primary subagent name, optional model/thinking/context settings, parent orchestration instruction, and child prompt. Additional parallel launches are configured separately in `phase-parallel.json`, keyed by phase. `phase-config.ts` only loads and renders those files. Common child workflow instructions, such as returning results to the parent and not calling `delivery_report`, are appended centrally from `index.ts`. Parent `delivery_report` instructions are hardcoded state-machine behavior in `index.ts`.

Phase files do not configure subagent tools. Subagent tool availability comes from the actual agent definition used by the subagent launcher. Verification phases use the `fresh-verifier` agent, installed from `agents/fresh-verifier.md` into `~/.pi/agent/agents/fresh-verifier.md`. If another child should not have delivery tools, configure that in the child agent definition, for example with dedicated delivery agents such as `delivery-worker` or `delivery-verifier`.

`delivery_next` returns `details.next.childPrompt` for single-child phases. `details.next.prompt` mirrors the same child prompt for compatibility; parent-only instructions are kept in `details.next.orchestratorInstruction` and hardcoded `details.next.reportInstruction`. When `phase-parallel.json` defines launches for a phase, `delivery_next` also returns `details.next.parallel` containing exactly those configured launches; the phase's primary agent is used only as the single-child fallback when no parallel config exists. Each parallel entry has a unique child prompt and artifact path instruction. The parent should launch all entries concurrently, save child artifacts separately, and call `delivery_report` once with the aggregate result.

`delivery_summary` reports completed phase counts from state-machine history. It also estimates usage by reading the current parent session JSONL plus subagent session JSONL files under the matching subagent session directory. When a delivery was started after this feature existed, it also reports usage since `delivery_start`; otherwise it reports current session totals only. When a delivery reaches `DONE`, `delivery_report`, `delivery_next`, and `delivery_status` show this summary automatically.

Phase markdown format:

```md
---
phase: IMPLEMENT
agent: worker
model: openai/gpt-5.5
thinking: low
context: fresh
---

## Orchestrator instruction
Parent-only launch instruction.

## Child prompt
Prompt passed to the subagent. Supports placeholders such as `{{task}}`, `{{artifactGuidance}}`, `{{verifyRound}}`, and `{{maxRepairRounds}}`.

```

Parallel launch config format (`phase-parallel.json`):

```json
{
  "REVIEW": [
    {
      "agent": "reviewer"
    },
    {
      "agent": "reviewer",
      "model": "openai/gpt-5.5"
    }
  ]
}
```

When a phase is present in `phase-parallel.json`, the configured entries replace the phase's primary launch list for that phase. Add every child you want to launch, including a default-model reviewer if desired. To launch multiple identical children, add multiple entries. Entries support `agent`, `model`, `thinking`, and `context`.

The phase prompts ask subagents to keep artifacts scan-friendly:

- start with verdict/result,
- include a short required checklist,
- separate blockers from non-blocking notes,
- keep evidence concise.

Close artifacts must include a close-readiness checklist:

- local fast verification passed after the final code change,
- whether code changed after that verification,
- smoke test run/skipped/not applicable with reason,
- unresolved blockers yes/no,
- worktree clean yes/no,
- branch/MR status when applicable,
- remote CI status as informational only.

Remote CI is not required before close unless the user explicitly asks. If it is still running, record it as `running, not waited for by design because local verification passed`.
