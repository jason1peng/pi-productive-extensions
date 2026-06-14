# delivery-state-machine

Pi extension for parent-controlled delivery orchestration.

## Commands

- `/deliver <task>` — start the state machine and prompt the parent agent to orchestrate subagents.
- `/delivery-status` — show current state.
- `/delivery-summary` — show the full delivery journey summary, including phase attempts, failures/repairs, artifact links, and session/subagent usage.
- `/delivery-reset` — reset to idle.

## Tools

- `delivery_start` — start from an agent turn.
- `delivery_next` — get the next required state/action, launch settings, and subagent prompt.
- `delivery_report` — report a completed phase and advance the state machine.
- `delivery_decide` — apply a parent/user decision for a pending blocker.
- `delivery_status` — inspect state.
- `delivery_summary` — summarize the full delivery journey with phase attempts, failures/repairs, artifact links, and session/subagent usage.
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

## Delivery configuration

Delivery run artifacts are stored under `~/.pi/delivery-run` by default. Built-in max rounds are `IMPLEMENT: 10`, `VERIFY: 5`, `REVIEW: 5`, `CLOSE: 3`, and `RETRO: 3`.

Override delivery settings with either config file:

- Global/user: `~/.pi/agent/extensions/delivery-state-machine.json`
- Project-local: `<repo>/.pi/delivery-state-machine.json` (overrides global)

Configuration is layered in this order: built-in defaults, then global/user config, then project-local config. Edit those config files instead of editing files inside the extension checkout when you want conflict-free local customization.

```json
{
  "artifactRoot": "~/delivery-reports",
  "maxRounds": {
    "IMPLEMENT": 10,
    "VERIFY": 5,
    "REVIEW": 5,
    "CLOSE": 3,
    "RETRO": 3
  },
  "phases": {
    "VERIFY": {
      "agent": "fresh-verifier",
      "thinking": "low",
      "context": "fresh"
    },
    "REVIEW": {
      "parallel": [
        { "agent": "reviewer" },
        { "agent": "reviewer" }
      ]
    }
  }
}
```

`artifactRoot` supports `~`, `${home}`, and `${cwd}`. Relative paths in project config resolve against the project cwd; relative paths in global config resolve against `~/.pi/agent`. For one-off runs, `PI_DELIVERY_ARTIFACT_ROOT` overrides both config files and resolves relative paths against the current cwd.

`maxRounds` supports `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO`. `IMPLEMENT`, `VERIFY`, and `REVIEW` currently bound repair loops; `CLOSE` and `RETRO` are recorded for phase-specific defaults and future loop support. The legacy `maxRepairRounds` key is still accepted as a config or `delivery_start` parameter and applies the same value to every phase.

`phases.<PHASE>` config owns launch/runtime settings: `agent`, `model`, `thinking`, `context`, and optional `parallel` launch entries. Built-in defaults omit `model`, so pi's default/current/subscription-backed model can be used without API-token-specific model pins.

Default/subscription model users usually do not need model config:

```json
{
  "phases": {
    "VERIFY": { "agent": "fresh-verifier" }
  }
}
```

Users who want explicit API model pins can set `model`:

```json
{
  "phases": {
    "VERIFY": { "model": "openai/gpt-5.5" },
    "REVIEW": {
      "parallel": [
        { "agent": "reviewer" },
        { "agent": "reviewer", "model": "openai/gpt-5.5" }
      ]
    }
  }
}
```

Use `model: null` only to clear a model inherited from another config layer. The launcher-facing config omits `model`; it never receives literal `null`:

```json
{
  "phases": {
    "VERIFY": { "model": null }
  }
}
```

Migration note: earlier bundled defaults pinned `IMPLEMENT` and `VERIFY` to `openai/gpt-5.5`, `CLOSE` to `global.anthropic.claude-haiku-4-5-20251001-v1:0`, and one default reviewer to `openai/gpt-5.5`. Those pins are no longer built in. Re-add them in global or project config if you want the old API-model behavior.

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

Repair loops are bounded by per-phase `maxRounds` (`maxRepairRounds` remains as a legacy all-phase override).

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

Phase prompts live in `phases/*.md` as prompt-only markdown. They define the parent orchestration instruction and child prompt text only. Launch/runtime behavior (`agent`, `model`, `thinking`, `context`, and `parallel`) belongs in the layered delivery-state-machine config described above. Phase markdown frontmatter is rejected with a migration error so users do not have duplicate places to configure models. Common child workflow instructions, such as returning results to the parent and not calling `delivery_report`, are appended centrally from `index.ts`. Parent `delivery_report` instructions are hardcoded state-machine behavior in `index.ts`.

Phase files do not configure subagent tools. Subagent tool availability comes from the actual agent definition used by the subagent launcher. Verification phases use the `fresh-verifier` agent, installed from `agents/fresh-verifier.md` into `~/.pi/agent/agents/fresh-verifier.md`. If another child should not have delivery tools, configure that in the child agent definition, for example with dedicated delivery agents such as `delivery-worker` or `delivery-verifier`.

`delivery_next` returns `details.next.childPrompt` for single-child phases. `details.next.prompt` mirrors the same child prompt for compatibility; parent-only instructions are kept in `details.next.orchestratorInstruction` and hardcoded `details.next.reportInstruction`. When `phases.<PHASE>.parallel` is configured, `delivery_next` also returns `details.next.parallel` containing exactly those configured launches; the phase's primary agent is used only as the single-child fallback when no parallel config exists. Each parallel entry has a unique child prompt and artifact path instruction. The parent should launch all entries concurrently, save child artifacts separately, and call `delivery_report` once with the aggregate result.

`delivery_summary` renders and writes the journey report to `<artifactDir>/00-delivery-summary.md`. The report lists every planned/reported phase step in order, including parallel reviewer rows, agent/model, verdict, artifact link, best-effort cost attribution, failure overview, repair action, retro critical fixes, phase counts, and usage totals. It estimates usage by reading the current parent session JSONL plus subagent session JSONL files under the matching subagent session directory. When a delivery was started after usage baseline tracking existed, it also reports usage since `delivery_start`; otherwise it reports current session totals only. Cost attribution is explicitly labeled as best-effort, phase-aggregate, or unavailable; zero cost is not inferred when no usage-bearing session data exists. When a delivery reaches `DONE`, final `delivery_report`, `delivery_next`, and `delivery_status` show this summary automatically and refresh `00-delivery-summary.md`.

Phase markdown format:

```md
## Orchestrator instruction
Parent-only launch instruction.

## Child prompt
Prompt passed to the subagent. Supports placeholders such as `{{task}}`, `{{artifactGuidance}}`, `{{verifyRound}}`, and `{{maxRepairRounds}}`.
```

Parallel launch config format in `delivery-state-machine.json`:

```json
{
  "phases": {
    "REVIEW": {
      "parallel": [
        { "agent": "reviewer" },
        { "agent": "reviewer", "model": "openai/gpt-5.5" }
      ]
    }
  }
}
```

When `parallel` is present for a phase, the configured entries replace the phase's primary launch list for that phase. Add every child you want to launch, including a default-model reviewer if desired. To launch multiple identical children, add multiple entries. Entries support `agent`, `model`, `thinking`, and `context`.

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
