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

Delivery run artifacts are stored under `~/.pi/delivery-run/projects/<project-id>/runs/<run-id>` by default, and runnable phases default to 3 max rounds. Override the artifact root and round defaults with either config file:

- Global: `~/.pi/agent/extensions/delivery-state-machine.json`
- Project-local: `<repo>/.pi/delivery-state-machine.json` (overrides global)

```json
{
  "artifactRoot": "~/delivery-reports",
  "maxRounds": {
    "IMPLEMENT": 4,
    "VERIFY": 2,
    "REVIEW": 3,
    "CLOSE": 1,
    "RETRO": 1
  }
}
```

`artifactRoot` supports `~`, `${home}`, and `${cwd}`. Relative paths in project config resolve against the project cwd; relative paths in global config resolve against `~/.pi/agent`. For one-off runs, `PI_DELIVERY_ARTIFACT_ROOT` overrides both config files and resolves relative paths against the current cwd. Every artifact root uses the same project layout: `<artifactRoot>/projects/<project-id>/runs/<run-id>`. The extension writes `<artifactRoot>/projects/<project-id>/project.json` with local project metadata for the report viewer.

`maxRounds` supports `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO`. `IMPLEMENT`, `VERIFY`, and `REVIEW` currently bound repair loops; `CLOSE` and `RETRO` are recorded for phase-specific defaults and future loop support. The legacy `maxRepairRounds` key is still accepted as a config or `delivery_start` parameter and applies the same value to every phase.

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

Structured report JSON uses schema version 2. The stable contract is documented in [../../docs/delivery-report-schema-v2.md](../../docs/delivery-report-schema-v2.md), and shared report/usage types live under `../../shared/`.

Delivery state-machine tools are hardcoded in `index.ts` and are intended for the parent/orchestrator session:

- `delivery_start`
- `delivery_next`
- `delivery_report`
- `delivery_decide`
- `delivery_status`
- `delivery_reset`

The `/deliver` bootstrap prompt lives in `prompts/deliver.md` so parent/orchestrator instructions are easy to review and edit. It supports placeholders such as `{{task}}` and `{{artifactDir}}`.

Phase prompts live in `phases/*.md`, similar to pi agent-style config files. Launch settings live separately in profile-based `phase-launches.json`. `phase-config.ts` layers built-in defaults and user/global overrides only; project-local phase prompt and launch overrides are not read. Common child workflow instructions, such as returning results to the parent and not calling `delivery_report`, are appended centrally from `index.ts`. Parent `delivery_report` instructions are hardcoded state-machine behavior in `index.ts`.

Prompt override paths, from lowest to highest precedence:

- Built-in: `extensions/delivery-state-machine/phases/*.md`
- User/global: `~/.pi/agent/extensions/delivery-state-machine/phases/*.md`

Launch/profile config paths, from lowest to highest precedence:

- Built-in: `extensions/delivery-state-machine/phase-launches.json`
- User/global: `~/.pi/agent/extensions/delivery-state-machine/phase-launches.json`

Active profile selection path:

- User/global: `~/.pi/agent/extensions/delivery-state-machine/active-profile.json`

`PI_DELIVERY_PROFILE` overrides the saved active profile for the current process. Profile resolution is pinned at `delivery_start`, so changing `active-profile.json` affects future deliveries, not phases already planned for an active delivery.

Phase files do not configure subagent launch settings or tools. Frontmatter may only declare `phase`; `agent`, `model`, `thinking`, `context`, `tools`, and `parallel` are rejected there. Subagent tool availability comes from the actual agent definition used by the subagent launcher. Verification phases use the `fresh-verifier` agent, installed from `agents/fresh-verifier.md` into `~/.pi/agent/agents/fresh-verifier.md`. If another child should not have delivery tools, configure that in the child agent definition, for example with dedicated delivery agents such as `delivery-worker` or `delivery-verifier`.

`delivery_next` returns `details.next.childPrompt` for single-child phases. `details.next.prompt` mirrors the same child prompt for compatibility; parent-only instructions are kept in `details.next.orchestratorInstruction` and hardcoded `details.next.reportInstruction`. When `phase-launches.json` configures multiple launches for a phase, `delivery_next` also returns `details.next.parallel` containing exactly those configured launches. Each parallel entry has a unique child prompt and artifact path instruction. The parent should launch all entries concurrently, save child artifacts separately, and call `delivery_report` once with the aggregate result.

`delivery_summary` renders and writes the journey report to `<artifactDir>/00-delivery-summary.md`. The report lists every planned/reported phase step in order, including parallel reviewer rows, agent/model, verdict, artifact link, best-effort cost attribution, failure overview, repair action, retro critical fixes, phase counts, and usage totals. It estimates usage by reading the current parent session JSONL plus subagent session JSONL files under the matching subagent session directory. Token totals use the shared policy documented in [../session-usage/README.md](../session-usage/README.md). When a delivery was started after usage baseline tracking existed, it also reports usage since `delivery_start`; otherwise it reports current session totals only. Cost attribution is explicitly labeled as best-effort, phase-aggregate, or unavailable; zero cost is not inferred when no usage-bearing session data exists. When a delivery reaches `DONE`, final `delivery_report`, `delivery_next`, and `delivery_status` show this summary automatically and refresh `00-delivery-summary.md`. Structured reports now use `schemaVersion: 2` and include project metadata plus the pinned launch profile used for the run.

Phase markdown format:

```md
---
phase: VERIFY
---

## Orchestrator instruction
Parent-only launch instruction. Supports placeholders such as `{{verifyRound}}` and `{{maxRepairRounds}}`.

## Child prompt
Prompt passed to the subagent. Supports placeholders such as `{{task}}`, `{{artifactGuidance}}`, `{{verifyRound}}`, and `{{maxRepairRounds}}`.

```

Prompt overrides are partial by section: an override file can provide only `## Child prompt` or only `## Orchestrator instruction`, and missing sections fall back to lower-precedence files. If frontmatter is omitted, the phase is inferred from the filename; if frontmatter is present and includes `phase`, it must match the filename's phase.

Launch profile config format (`phase-launches.json`):

```json
{
  "defaultProfile": "premium",
  "profiles": {
    "premium": {
      "IMPLEMENT": { "agent": "worker", "model": "openai/gpt-5.5" },
      "VERIFY": { "agent": "fresh-verifier", "model": "openai/gpt-5.5", "thinking": "low", "context": "fresh" },
      "REVIEW": [
        { "agent": "reviewer" },
        { "agent": "reviewer", "model": "openai/gpt-5.5" }
      ],
      "CLOSE": { "agent": "delegate", "thinking": "low" },
      "RETRO": { "agent": "delegate", "thinking": "high" }
    },
    "quota-saving": {
      "IMPLEMENT": { "agent": "worker", "model": "openai/gpt-5-mini" },
      "VERIFY": { "agent": "fresh-verifier", "model": "openai/gpt-5-mini", "thinking": "low", "context": "fresh" },
      "REVIEW": { "agent": "reviewer", "model": "openai/gpt-5-mini" },
      "CLOSE": { "agent": "delegate", "model": "openai/gpt-5-mini", "thinking": "low" },
      "RETRO": { "agent": "delegate", "model": "openai/gpt-5-mini", "thinking": "high" }
    }
  }
}
```

Each profile must define every runnable phase: `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO`. A phase value may be one launch object or an array of launch objects. Arrays mean parallel children for that phase. Entries support `agent`, `model`, `thinking`, and `context`. To force GPT-only or Claude-only execution, define profiles in user/global `phase-launches.json` with the model names available to your subscription, then select one with `active-profile.json` or `PI_DELIVERY_PROFILE`.

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
