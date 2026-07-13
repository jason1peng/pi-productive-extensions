# git-cleanup

Adds `/cleanup` for the common post-merge repo housekeeping flow.

For compatibility with RPC clients that wait for Pi's agent lifecycle, `/cleanup` starts an agent turn that invokes the `git_cleanup` tool. This also makes RPC agent cancellation reach the Git process. The extra model turn is a temporary workaround for the [Paseo extension-command lifecycle issue](../../docs/paseo-extension-command-lifecycle.md).

The tool is intentionally designed for a single-user local workflow:

1. It must be invoked from the repository's stable primary checkout. Invocation from a linked worktree fails with the primary path to use instead.
2. `main` must either be checked out in the primary checkout or be available there while the primary checkout is on an eligible `plan/<slug>` branch. Unexpected layouts, detached HEAD, and non-planning primary branches fail with recovery instructions.
3. Before fetching or mutating anything, it reads the status and untracked/ignored paths of every worktree. An unreadable status fails the operation rather than being treated as clean.
4. A live run fetches `origin/main`; a dry-run reads the current remote OID and downloads missing objects without updating local refs or `FETCH_HEAD`.
5. Local `main` must be fast-forwardable. The primary checkout must have no tracked changes, and untracked or ignored content that would be overwritten by switching or fast-forwarding is preserved with an error.
6. If the primary checkout is on a merged or patch-equivalent `plan/<slug>` branch, cleanup switches it back to `main`, fast-forwards, and deletes the planning branch. Other branches are never displaced automatically.
7. Clean linked worktrees are eligible when their HEAD is merged or their merge-free commit range is patch-equivalent to remote main. Merge-containing ranges are not accepted through patch equivalence because `git cherry` cannot prove unique merge-resolution content is upstream.
8. Linked worktrees with tracked changes or unrecognized untracked/ignored content are skipped. A worktree containing only `.pi-subagents/` runtime state is eligible: cleanup deletes that recognized directory, removes the worktree without `--force`, and deletes its branch.
9. Cleanup prunes stale worktree metadata and leaves the primary checkout on `main`.

Concurrent external Git or filesystem mutation during cleanup is out of scope. The command makes its safety decisions from the preflight snapshot and relies on Git's normal non-force checks; callers should not edit worktrees or refs while it runs.

Git commands run asynchronously through Pi's abortable process API. Local commands time out after 15 seconds, network commands after 60 seconds, and interactive credential prompts are disabled. Progress/status is cleared on success, failure, or cancellation.

The implementation requires a Git version whose `git switch` supports `--no-overwrite-ignore`. Unsupported Git fails rather than silently falling back to overwrite-prone behavior.

Options:

- `/cleanup --dry-run` or `/cleanup -n` — query current remote main and show the resulting plan without changing worktrees, branches, HEAD, `FETCH_HEAD`, or refs (missing commit objects may be downloaded).
- `/cleanup --main trunk` — use a different main branch name.
- `/cleanup --force-current` — retained for argument compatibility; the supported lifecycle requires invocation from the primary checkout, which is never removed.
