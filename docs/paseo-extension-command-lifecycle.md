# Paseo and Pi extension-command lifecycle issue

## Status

Deferred for a future Paseo-side fix. The `git-cleanup` extension currently uses an agent/tool workaround.

## Problem

Paseo sends `/cleanup` to Pi RPC as a `prompt` and waits for the normal agent lifecycle to settle. Pi recognizes `/cleanup` as an extension command and runs its `registerCommand()` handler directly, bypassing the LLM/agent loop. Consequently, the command does not emit `agent_start`, `agent_end`, or `agent_settled`, even though the correlated RPC `prompt` response indicates that the extension command handler finished.

Paseo can therefore remain in a running state after cleanup has completed. Sending RPC `abort` does not reliably cancel such a command either: it aborts an active agent operation, while a directly executing extension command may have no active agent signal.

## Intended Paseo-side fix

Paseo should distinguish extension commands from ordinary prompts, using Pi RPC `get_commands` and the correlated `prompt` response:

- For an ordinary prompt, treat acceptance as non-terminal and wait for `agent_settled`.
- For an extension command, treat the successful correlated `prompt` response as terminal instead of waiting for agent events.
- Do not show the operation as cancellable after that terminal response.
- If cancellation of long-running extension commands is required, define a command-specific cancellation mechanism rather than relying on agent `abort`.

## Temporary workaround

`/cleanup` now sends an agent prompt that invokes the `git_cleanup` tool. Git work therefore runs inside Pi's normal tool/agent lifecycle, emits the events Paseo expects, and receives the tool execution `AbortSignal`. This costs an otherwise unnecessary model turn and should be removed after Paseo handles extension-command completion correctly.
