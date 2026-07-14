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

A planning-only MR on a `plan/<slug>` branch may be created and submitted directly from the stable primary checkout; a dedicated worktree solely for planning is not required. After the plan is approved or merged, implementation and delivery must use a dedicated git worktree created from the latest fetched `main`, never from the planning branch. The same implementation-worktree requirement applies to new repository tasks unless the delivery is continuing the same task or amending its requirement. Non-git/non-repo tasks should record why the worktree policy is not applicable. The delivery status line includes the current working branch when the current cwd is inside a git worktree.

## Bounded verification and review

Verification and review investigate broadly but block narrowly. Findings are adjudicated, in precedence order, against the accepted user task and explicit decisions, documented product or repository invariants, the accepted implementation plan, the documented supported operating and threat model, and explicit exclusions. A lower-level plan or exclusion cannot excuse a higher-level requirement, while a reviewer cannot make a stronger contract mandatory merely because it would be safer.

Every meaningful concern remains visible in one of four destinations: a requirement or invariant violation is blocking; a realistic regression (including destructive data loss) in the supported workflow is blocking; an unsupported/adversarial scenario or optional hardening is non-blocking by default; and a potential product, safety, concurrency, or threat-model contract change requires parent/user judgment. Contract suggestions remain non-gating unless the decision is necessary to judge or continue the task. Unsupported concurrency or hostile external Git/filesystem mutation is therefore hardening unless the accepted contract includes it.

Every must-fix finding must cite the exact accepted requirement or invariant violated, a realistic reproducer inside the supported operating model, and why existing safeguards and tests are insufficient. A supported finding with this evidence may be reported with `recommendedDecision: repair`; the machine then routes back to `IMPLEMENT` automatically with the pending issue attached. `IMPLEMENT` is the only writer phase. Verdict labels do not override contradictory evidence, and genuine in-scope defects are never downgraded because repair is difficult.

If pi-subagents exhausts its session launch capacity, a required independent gate remains blocked: the parent must not synthesize PASS or perform substitute self-verification, and completion requires a new Pi session. Precise capacity reservation is deferred until pi-subagents exposes a reliable capacity interface.

Failures move to `WAITING_DECISION` when repair needs an explicit parent/user choice, including exhausted round budgets. User-facing prompts offer:

- `repair`
- `accept_risk`
- `stop`

The tool schema still accepts legacy `continue` and `defer` values for compatibility. `continue` maps to `accept_risk`, including risk recording, and `defer` maps to `stop`; neither is offered in prompts. Accepting risk on a failed IMPLEMENT stops the run rather than treating incomplete code as a verified candidate.

Repair loops are bounded by per-phase `maxRounds` (`maxRepairRounds` remains as a legacy all-phase override). When a user explicitly selects `repair` at exhaustion, the machine extends only the IMPLEMENT/VERIFY/REVIEW limits needed for one additional complete repair cycle and records the authorization without resetting attempts or history.

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

Phase prompts live in `phases/*.md`, similar to pi agent-style config files. Launch settings live separately in profile-based `phase-launches.json`. `phase-config.ts` layers built-in defaults and user/global overrides only; project-local phase prompt and launch overrides are not read. See [docs/prompt-construction.md](docs/prompt-construction.md) for the complete prompt assembly order, configurable boundaries, central artifact contract, and report-time enforcement. See [docs/user-space-overrides.md](docs/user-space-overrides.md) for a step-by-step user-space override guide. Common child workflow instructions, such as returning results to the parent and not calling `delivery_report`, are appended centrally from `index.ts`. A stable static project-harness discovery block is placed before the separately generated resolved-root context and the resolved built-in/user phase prompt. This keeps the cacheable prefix stable while allowing a later full user override to refine or override prompt guidance. Parent `delivery_report` instructions are hardcoded state-machine behavior in `index.ts`.

## Project harness discovery

Every runnable phase starts a bounded discovery attempt at the resolved repository or worktree root. It checks existing common contributor/instruction entrypoints, applicable directory-scoped instructions, and explicit mandatory or phase-relevant references. Package scripts and CI/workflow files are inspected only when needed; agents are told not to recursively read unrelated docs.

Discovery is a bounded best-effort check, and a project harness is optional: `none discovered` is a normal valid successful outcome, and absent common filenames are not errors. Missing explicitly referenced files are gaps. Unreadable or conflicting mandatory instructions, or applicable instructions that were skipped or violated, use `blocked`. Every new artifact records discovery scope, entrypoints, references, applied rules, gaps/conflicts, and one authoritative `Outcome: applied | none discovered | blocked`; no separate compliance-status field is required. `applied` and `none discovered` permit success, while `blocked` rejects it. Historical unsuccessful artifacts remain readable without migration. Parallel review children and their regenerated aggregate preserve and derive the same evidence.

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

`delivery_next` returns `details.next.childPrompt` for single-child phases. `details.next.prompt` mirrors the same child prompt for compatibility; parent-only instructions are kept in `details.next.orchestratorInstruction` and hardcoded `details.next.reportInstruction`. When `phase-launches.json` configures multiple launches for a phase, `delivery_next` also returns `details.next.parallel` containing exactly those configured launches. Each parallel entry has a unique child prompt plus `artifact`, `output`, and `outputMode: "file-only"` fields for its child artifact. The parent should launch all entries concurrently, pass the output fields when supported, save every child artifact at its exact planned path, and call `delivery_report` once with the aggregate result. When subagent results expose usage, a run id, or a session JSONL path, pass that metadata to `delivery_report`: single-child phases use `usageDelta`, `subagentRunId`, or `subagentSessionFile`; parallel phases use one `stepUsage[]` entry per child keyed by `childIndex`, `stepId`, or artifact. If explicit usage metadata is omitted, `delivery_report` also scans existing pi-subagents metadata files (`.pi-subagents/artifacts/*_meta.json`) in the delivery cwd and known git worktrees. It matches child usage deterministically by the planned artifact path embedded in `meta.task`, plus agent/timestamp checks, and copies `meta.usage`, `meta.runId`, and `meta.transcriptPath` onto the matching delivery step. If `usageDelta` is omitted but `subagentSessionFile` or `subagentRunId` is provided, `delivery_report` can parse child-native usage from `subagentSessionFile` or discover matching subagent rows by `subagentRunId` under the current parent session. `delivery_report` rejects new reports unless every artifact uses its exact planned path, is a non-empty regular file contained in the run directory without symlink escape, starts with a phase-valid `RESULT` line, includes the phase headings, and has valid local artifact links. Parallel VERIFY/REVIEW aggregates are regenerated with atomic file replacement, so structured reports do not contain stale or broken child artifact links.

`delivery_summary` renders and writes the journey report to `<artifactDir>/00-delivery-summary.md`. The report lists every planned/reported phase step in order, including parallel reviewer rows, agent/model, verdict, artifact link, best-effort token usage, failure overview, repair action, retro critical fixes, phase counts, and usage totals. It estimates usage by reading the current parent session JSONL plus subagent session JSONL files under the matching subagent session directory. Token totals use the shared policy documented in [../session-usage/README.md](../session-usage/README.md). When a delivery was started after usage baseline tracking existed, it also reports usage since `delivery_start`; otherwise it reports current session totals only. Phase token usage is explicitly labeled as best-effort, phase-aggregate, or unavailable; dollar cost is shown only in total usage summaries from recorded session usage, and zero cost is not inferred when no usage-bearing session data exists. When a delivery reaches `DONE`, final `delivery_report`, `delivery_next`, and `delivery_status` show this summary automatically and refresh `00-delivery-summary.md`. Structured reports now use `schemaVersion: 2` and include project metadata plus the pinned launch profile used for the run.

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
