# Delivery user-space overrides

Use user-space overrides when you want this package to keep its built-in defaults, but your local Pi install should launch delivery phases with your own agents, models, or prompts.

## Paths

By default, overrides live under:

```text
~/.pi/agent/extensions/delivery-state-machine/
```

If Pi is running with `PI_CODING_AGENT_DIR`, replace `~/.pi/agent` with that directory.

Supported override files:

```text
phase-launches.json          # phase agents/models/thinking/context profiles
active-profile.json          # selected launch profile
phases/<phase>.md            # optional prompt section overrides
```

Project-local phase launch or prompt files are intentionally ignored. Delivery model setup is global/user-space only.

## Override phase launch models

Create or edit:

```text
~/.pi/agent/extensions/delivery-state-machine/phase-launches.json
```

Example:

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "IMPLEMENT": {
        "agent": "worker",
        "model": "openai/gpt-5.5"
      },
      "VERIFY": {
        "agent": "fresh-verifier",
        "model": "openai/gpt-5.5",
        "thinking": "low",
        "context": "fresh"
      },
      "REVIEW": [
        {
          "agent": "reviewer",
          "model": "amazon-bedrock/global.anthropic.claude-opus-4-7"
        },
        {
          "agent": "reviewer",
          "model": "openai/gpt-5.5"
        }
      ],
      "CLOSE": {
        "agent": "delegate",
        "model": "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        "thinking": "low"
      },
      "RETRO": {
        "agent": "delegate",
        "model": "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        "thinking": "high"
      }
    }
  }
}
```

Rules:

- The file must use the profile shape: `defaultProfile` plus `profiles`.
- Every profile must define every runnable phase: `IMPLEMENT`, `VERIFY`, `REVIEW`, `CLOSE`, and `RETRO`.
- A phase can be a single launch object or an array. Arrays launch parallel children for that phase.
- Launch entries support only `agent`, `model`, `thinking`, and `context`.
- `thinking` must be `low`, `medium`, or `high`.
- `context` must be `fresh` or `fork`.

## Add multiple profiles

You can keep multiple model setups in the same file:

```json
{
  "defaultProfile": "premium",
  "profiles": {
    "premium": {
      "IMPLEMENT": { "agent": "worker", "model": "openai/gpt-5.5" },
      "VERIFY": { "agent": "fresh-verifier", "model": "openai/gpt-5.5", "thinking": "low", "context": "fresh" },
      "REVIEW": { "agent": "reviewer", "model": "amazon-bedrock/global.anthropic.claude-opus-4-7" },
      "CLOSE": { "agent": "delegate", "model": "amazon-bedrock/global.anthropic.claude-sonnet-4-6", "thinking": "low" },
      "RETRO": { "agent": "delegate", "model": "amazon-bedrock/global.anthropic.claude-sonnet-4-6", "thinking": "high" }
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

Select a saved active profile with:

```json
{
  "activeProfile": "quota-saving"
}
```

Save that as:

```text
~/.pi/agent/extensions/delivery-state-machine/active-profile.json
```

For one Pi process, `PI_DELIVERY_PROFILE=<profile>` overrides `active-profile.json`.

Profile selection precedence:

```text
PI_DELIVERY_PROFILE
> active-profile.json
> defaultProfile
> first profile in phase-launches.json
```

Profile resolution is pinned when `delivery_start` runs. Changing the active profile affects future deliveries, not a delivery already in progress.

## Override phase prompt text

Prompt overrides are optional and separate from launch/model overrides.

Create one of:

```text
~/.pi/agent/extensions/delivery-state-machine/phases/implement.md
~/.pi/agent/extensions/delivery-state-machine/phases/verify.md
~/.pi/agent/extensions/delivery-state-machine/phases/review.md
~/.pi/agent/extensions/delivery-state-machine/phases/close.md
~/.pi/agent/extensions/delivery-state-machine/phases/retro.md
```

Example partial override:

```md
---
phase: VERIFY
---

## Child prompt

Use the standard verifier behavior, but always include the exact command output for failed checks.

Task: {{task}}
{{artifactGuidance}}
```

Rules:

- Override files can define only `## Orchestrator instruction`, only `## Child prompt`, or both.
- Missing sections fall back to the built-in phase prompt.
- Frontmatter may only declare `phase`.
- Do not put `agent`, `model`, `thinking`, `context`, `tools`, or `parallel` in phase markdown; those belong in `phase-launches.json` or the agent definition.

## Validate the override

Validate JSON syntax:

```bash
python3 -m json.tool ~/.pi/agent/extensions/delivery-state-machine/phase-launches.json >/dev/null
```

Validate the delivery resolver from this repo:

```bash
NODE_PATH=${NODE_PATH:-$HOME/.pi/agent/npm/node_modules} bun -e 'import { loadPhaseConfigBundle } from "./extensions/delivery-state-machine/phase-config.ts"; console.log(JSON.stringify(loadPhaseConfigBundle(), null, 2));'
```

A successful resolver output should show:

- `definitionSource: "global-phase-launches"`
- the expected selected profile
- each phase using the intended agent/model/thinking/context

You can also start a delivery and inspect `delivery_next`; launch fields are returned as `details.next.agent/model/thinking/context` or `details.next.parallel[]` for parallel phases.

## Troubleshooting

- **Built-in defaults are still used**: confirm the file path is under the Pi agent dir used by the running process. Check `PI_CODING_AGENT_DIR`.
- **Selected profile is wrong**: check `PI_DELIVERY_PROFILE`, then `active-profile.json`, then `defaultProfile`.
- **Config error about missing phase**: every profile must define all five runnable phases.
- **Config error about invalid key**: launch objects support only `agent`, `model`, `thinking`, and `context`.
- **Prompt override rejected**: remove launch/model/tool keys from phase markdown and put them in `phase-launches.json` or the child agent definition.
