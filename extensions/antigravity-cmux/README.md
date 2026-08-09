# antigravity-cmux

`antigravity-cmux` is a normal Pi subagent that keeps Pi as the orchestrator and uses a visible cmux terminal pane as the execution surface for one bounded Antigravity CLI (`agy`) task. It is not an `external-cli` runner and does not replace pi-subagents lifecycle supervision.

## Prerequisites

1. Install cmux and authenticate `agy` interactively before starting a task. Use `agy`'s scoped permission settings; this package does not recommend blanket dangerous-permission bypasses.
2. Install cmux's maintained skills from the official source, then make them visible to Pi. Do not fork them into this repository:

   ```bash
   npx skills add manaflow-ai/cmux --skill cmux --skill cmux-workspace -g -y --copy
   # If your skills installer targets another agent directory, copy only these
   # two official directories into ~/.pi/agent/skills/.
   test -f ~/.pi/agent/skills/cmux/SKILL.md
   test -f ~/.pi/agent/skills/cmux-workspace/SKILL.md
   ```

   See <https://cmux.com/docs/skills> for the maintained installation flow. A fresh Pi session (or reload) must discover both skill names before launching the subagent.
3. Use a task worktree with one active writer. If the parent or another worker may edit concurrently, use a managed worktree rather than a shared checkout.

## Launch behavior

The child identifies the caller workspace and surface with the official `cmux` and `cmux-workspace` skills, then creates one additive right-hand terminal pane with focus disabled. It creates `.pi-subagents/antigravity-cmux/<run>/` in the task worktree with mode `0700`, stores `prompt.md` as mode `0600`, and invokes `bin/launch-agy`.

The helper sends cmux a fixed command containing only shell-quoted paths and fixed shell text:

```text
cd -- <quoted-worktree> && prompt=$(cat -- <quoted-prompt>; printf '\001') && prompt=${prompt%?} && agy -p "$prompt"; ...
```

The prompt is read from the private file after cmux accepts the command; raw task text is never cmux control input. The sentinel preserves trailing newlines. `status.env` is the bounded human-readable completion marker and includes `state`, `exit_code`, workspace, caller surface, new surface, worktree, and prompt paths. The pane remains open after success or failure for human visibility.

`agy -p` is headless and one-shot. It can execute the supplied prompt but cannot conduct a native live parent-agent decision through cmux. When a follow-up decision is needed, the Pi parent stages a new prompt, or the user responds manually in the still-visible pane. cmux is not an agent-to-agent messaging protocol.

## Focused checks

The fake-command suite does not require cmux, `agy`, credentials, or a live socket:

```bash
bun extensions/antigravity-cmux/tests/antigravity-cmux.test.ts
bash -n extensions/antigravity-cmux/bin/launch-agy
```

Live smoke testing should use a disposable worktree and a harmless authenticated `agy` prompt. Confirm the right-hand pane, returned surface ID, status marker, same-worktree execution, and intentionally retained pane before using a real task.
