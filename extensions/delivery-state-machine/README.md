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

This package exposes five package-scoped pi-subagents roles through `pi.subagents.agents`: `dsm.implementer`, `dsm.verifier`, `dsm.reviewer`, `dsm.closer`, and `dsm.retrospective`. They are available for the non-default `dsm-candidate` launch profile without copying agent files into user or project configuration.

The bundled `default` profile remains unchanged until the Stage 7 quality gate. Its `VERIFY` phase still launches the user-scoped `fresh-verifier`; install that compatibility agent before using the default profile:

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

The opt-in Stage 6 host smoke creates an isolated Pi agent directory and Git project, proves all five roles resolve with package source identity, launches each role with a real model, and preserves its evidence directory. It is intentionally excluded from `npm run verify` because it consumes model quota:

```bash
DSM_SMOKE_MODEL=openai-codex/gpt-5.6-sol extensions/delivery-state-machine/scripts/isolated-host-smoke.sh
```

Use `DSM_SMOKE_MODEL` to select a model available to the current Pi authentication. The isolated host copies authentication into a separate temporary agent home that is removed on exit or interruption; credential files are never retained in the evidence directory. It sets the selected model as `subagents.defaultModel`, while phase children use the bundled provider-neutral `dsm-candidate` profile unchanged. The candidate deliberately has no explicit model fields: model selection belongs to user profile overrides, `subagents.defaultModel`, or the current Pi model, and Stage 7 pins models for controlled benchmarks. Stable thinking defaults live in the packaged verifier (`low`), closer (`low`), and retrospective (`high`) agent frontmatter so the parent does not need to relay them; explicit profile overrides remain supported and runtime-enforced. The smoke verifies inherited actual models, agent-owned thinking defaults, every configured context and output path, and the parallel REVIEW launch. Set `DSM_SMOKE_EVIDENCE_DIR` to retain evidence at a specific path. The harness preserves the bundled profile plus requested and actual launch records under `results/`, writes timestamped phase/session progress to `results/progress.log`, enforces a 12-minute internal deadline, and terminates and waits for the complete Pi process group on timeout, an exceptional exit, or HUP/INT/TERM interruption (escalating to SIGKILL when needed); override the deadline with `DSM_SMOKE_TIMEOUT_SECONDS` (minimum 60).

## Delivery configuration

Delivery run artifacts are stored under `~/.pi/delivery-run/projects/<project-id>/runs/<run-id>` by default, and runnable phases default to 3 max rounds. Override the artifact root and round defaults with either config file:

- Global: `~/.pi/agent/extensions/delivery-state-machine.json`
- Project-local: `<repo>/.pi/delivery-state-machine.json` (overrides global only when Pi trusts the project)

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

`artifactRoot` supports `~`, `${home}`, and `${cwd}`. The project root is the Git root when available, otherwise Pi's current cwd. Relative paths in trusted project config and `PI_DELIVERY_ARTIFACT_ROOT` resolve against that project root; relative paths in global config resolve against `~/.pi/agent`. Untrusted project configuration is ignored, while global configuration and the environment override remain available. Configuration is resolved once when a delivery starts. Every artifact root uses the same project layout: `<artifactRoot>/projects/<project-id>/runs/<run-id>`. The extension writes `<artifactRoot>/projects/<project-id>/project.json` with local project metadata for the report viewer.

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

While an active delivery is not in `CLOSE`/`RETRO`/`DONE`, the extension blocks agent `bash` commands that create/push PR/MR branches:

- `git push` (including `git -C`, `env`, `command`, executable-path, separator/newline, and nested `sh -c`/`bash -c` forms)
- `glab mr create`
- `gh pr create`

Authorization comes from canonical workflow phase state; the legacy `readyToClose` field is normalized for compatibility and is not an independent bypass. Malformed active restored state fails closed. This guard is defense in depth, not a shell security boundary, and it does not intercept deliberate human `user_bash` (`!`/`!!`) commands.

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

The packaged `dsm.*` agents own stable role policy, safety/mutation rules, evidence methodology, verdict discipline, and artifact expectations in their system prompts. When a DSM agent is selected, the matching built-in `## DSM child prompt` supplies only run-specific task/round/repair context; the runtime still prepends the authoritative `PHASE_CONTRACTS` structure and appends the resolved root and exact artifact path. A user/global `## Child prompt` remains a complete prompt override for default and DSM profiles, preserving existing override behavior. Orchestrator launch/report instructions are never copied into child prompts.

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

Phase files do not configure subagent launch settings or tools. Frontmatter may only declare `phase`; `agent`, `model`, `thinking`, `context`, `tools`, and `parallel` are rejected there. Subagent tool availability comes from the actual agent definition used by the subagent launcher. The packaged DSM agents load no extensions, so parent-only delivery tools are absent: only `dsm.implementer` receives `edit`/`write`; verifier/reviewer are read-only; closer has Git-capable `bash` but no source editing tools; retrospective is read-only by policy and has no editing tools. The default profile's verification phase continues to use `fresh-verifier`, installed from `agents/fresh-verifier.md` into `~/.pi/agent/agents/fresh-verifier.md`, until the Stage 7 adoption decision.

`delivery_next` returns `details.next.childPrompt` for single-child phases. `details.next.prompt` mirrors the same child prompt for compatibility; parent-only instructions are kept in `details.next.orchestratorInstruction` and hardcoded `details.next.reportInstruction`. Parallel launches receive unique exact artifact paths. The parent saves those artifacts and reports one aggregate result; it no longer needs to copy usage metadata into `delivery_report`.

Child usage is resolved at the pi-subagents persistence boundary. The adapter sums every `modelAttempts[].usage` entry (including failed fallback attempts), reads historical top-level `usage`, and validates totals against async transcript `message_end` records. When metadata has no usage, transcript totals are a fallback only if the transcript ends with a terminal assistant `message_end` rather than an in-progress tool call. It matches the exact planned artifact plus child-specific agent, timing, metadata file, and transcript identity. A shared parallel run ID is not a unique identity. Missing, incomplete, corrupt, ambiguous, or contradictory evidence is recorded as unavailable rather than guessed. The legacy `usageDelta`, `stepUsage`, session-file, and run-ID report fields remain parseable for schema compatibility, but exact adapter evidence wins.

`delivery_summary` renders and atomically replaces the journey report at `<artifactDir>/00-delivery-summary.md` and its schema-v2 JSON companion. Derived write failures are returned as warnings and never reverse a completed workflow transition; unique temporary files are cleaned up and prior valid destinations are preserved. Retro summaries prefer canonical `## Critical fixes` and retain the old longer heading as a read fallback. Delivery total is current session usage minus the `delivery_start` baseline. Parent/orchestrator overhead is reported only when every delivery child has exact unique usage; otherwise child/overhead completeness is unavailable. Aggregate VERIFY/REVIEW rows never contribute usage. Status and summary rendering use immutable snapshots and never backfill or mutate live workflow state. Tool text is bounded with Pi's standard 50KB/2,000-line limits while complete structured `details` and full saved reports remain available.

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
    "dsm-candidate": {
      "IMPLEMENT": { "agent": "dsm.implementer", "context": "fresh" },
      "VERIFY": { "agent": "dsm.verifier", "context": "fresh" },
      "REVIEW": [{ "agent": "dsm.reviewer", "context": "fresh" }, { "agent": "dsm.reviewer", "context": "fresh" }],
      "CLOSE": { "agent": "dsm.closer", "context": "fresh" },
      "RETRO": { "agent": "dsm.retrospective", "context": "fresh" }
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

Each profile must define every runnable phase: `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO`. A phase value may be one launch object or an array of launch objects. Arrays mean parallel children for that phase. Entries support `agent`, `model`, `thinking`, and `context`. Agent frontmatter supplies the bundled DSM roles' stable thinking defaults. A profile `thinking` value is an explicit user launch override and remains mandatory during an active delivery: the extension blocks a `subagent` call that omits or changes one and tells the orchestrator to retry with the value returned by `delivery_next`; this applies to both single launches and entries in parallel `tasks[]`. To force GPT-only or Claude-only execution, define profiles in user/global `phase-launches.json` with the model names available to your subscription, then select one with `active-profile.json` or `PI_DELIVERY_PROFILE`.

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
