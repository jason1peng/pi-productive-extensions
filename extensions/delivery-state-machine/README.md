# delivery-state-machine

A Pi extension for delivering coding tasks through a controlled, evidence-based workflow.

It coordinates implementation, independent verification, review, close, and retrospective work while keeping the parent session in control of every transition.

## Core concepts

- **Parent-controlled workflow** — Pi decides the next required action; subagents return evidence but do not advance the workflow themselves.
- **Independent quality gates** — verification and review run separately from implementation and must pass before close.
- **Single-writer implementation** — implementation is the only phase that edits source code. Other phases verify, review, close, or reflect on the result.
- **Bounded repairs** — failed gates can return to implementation without creating an unlimited loop. Decisions that need a person pause the delivery.
- **Profiles** — choose generic pi-subagents roles or the packaged `dsm.*` roles without changing the delivery workflow.
- **Persistent evidence** — each run keeps phase artifacts, decisions, usage, and a final Markdown/JSON report under `~/.pi/delivery-run` by default.

## Setup

Install this repository as a Pi package:

```json
{
  "packages": [
    "/path/to/pi-productive-extensions"
  ]
}
```

Git package installation is also supported:

```json
{
  "packages": [
    "git:github.com/jason1peng/pi-productive-extensions"
  ]
}
```

Restart Pi or run `/reload` after changing package configuration.

### Available profiles

The extension currently includes:

- **`default`** — uses the existing generic pi-subagents roles and prompts.
- **`dsm-candidate`** — uses packaged, phase-specific `dsm.implementer`, `dsm.verifier`, `dsm.reviewer`, `dsm.closer`, and `dsm.retrospective` agents.

The default profile still expects the compatibility verifier in your user agent directory:

```bash
mkdir -p ~/.pi/agent/agents
cp extensions/delivery-state-machine/agents/fresh-verifier.md ~/.pi/agent/agents/fresh-verifier.md
```

Select a profile for the current process:

```bash
PI_DELIVERY_PROFILE=dsm-candidate pi
```

Or save the selection in `~/.pi/agent/extensions/delivery-state-machine/active-profile.json`:

```json
{
  "activeProfile": "dsm-candidate"
}
```

Profile selection is pinned when a delivery starts.

## Basic usage

Start a delivery:

```text
/deliver Implement the approved authentication plan
```

Pi will guide the parent session through the required work and quality gates. When a gate finds a supported defect, the workflow can return to implementation. It pauses when a repair, risk, or stop decision requires user input.

Useful commands:

- `/delivery-status` — show the current phase, attempt, branch, and next state.
- `/delivery-summary` — show the delivery journey, artifacts, and usage.
- `/delivery-reset` — clear the active delivery state.

The same workflow is available to agents through `delivery_start`, `delivery_next`, `delivery_report`, `delivery_decide`, `delivery_status`, `delivery_summary`, and `delivery_reset`.

## Feature showcase

### Independent parallel review

A profile can launch multiple reviewers independently. The parent aggregates their artifacts before reporting one review result.

### Safe close

Push and PR/MR creation remain blocked until verification passes and review has no blockers. Close runs the repository's fast local checks, confirms candidate completeness, and records the branch, commit, and PR/MR URL.

### Repair decisions

Supported defects can route back to implementation. Exhausted budgets or contract decisions pause the run for an explicit `repair`, `accept_risk`, or `stop` choice.

### Delivery reports

Every completed run produces:

- `00-delivery-summary.md` — human-readable journey and outcome.
- `delivery-report.json` — structured report for tools such as the bundled report viewer.
- phase artifacts containing verdicts, checks, evidence, findings, and residual risks.

Run the local report viewer from the repository root:

```bash
npm run report-viewer
```

## Basic configuration

Configure artifact storage and phase attempt limits globally in `~/.pi/agent/extensions/delivery-state-machine.json`, or in a trusted project's `.pi/delivery-state-machine.json`:

```json
{
  "artifactRoot": "~/delivery-reports",
  "maxRounds": {
    "IMPLEMENT": 4,
    "VERIFY": 3,
    "REVIEW": 3,
    "CLOSE": 1,
    "RETRO": 1
  }
}
```

User-space phase prompt, launch profile, model, thinking, and context overrides are supported. See [User-space overrides](docs/user-space-overrides.md) for examples.

## Further documentation

- [Documentation index](docs/index.md) — advanced guides and configuration references.
- [Prompt construction](docs/prompt-construction.md) — system-prompt and dynamic child-prompt boundaries.
- [Delivery report schema](../../docs/delivery-report-schema-v2.md) — stable structured report contract.
- [Compatibility baseline](COMPATIBILITY_BASELINE.md) — preserved commands, tools, state, and report behavior.
- [Improvement plan](IMPROVEMENT_PLAN.md) — staged roadmap and acceptance gates.
- [Delivery-agent quality framework](benchmarks/agent-quality/README.md) — offline validation, opt-in real-Pi canary, scenarios, evidence, and later benchmark commands.

## Development

Run the repository's fast verification suite:

```bash
npm run verify
```

The model-backed isolated-host smoke test is intentionally opt-in because it consumes model quota:

```bash
DSM_SMOKE_MODEL=openai-codex/gpt-5.6-sol \
  extensions/delivery-state-machine/scripts/isolated-host-smoke.sh
```
