# git-cleanup

Adds `/cleanup` for the common post-merge repo housekeeping flow.

The command:

1. Finds the repository's `main` worktree.
2. Runs `git fetch origin main --prune` and `git pull --ff-only origin main` there.
3. Removes clean non-main worktrees whose HEAD is already merged into `origin/main` or whose commits are patch-equivalent to commits already on `origin/main` (for rebased/cherry-picked MR merges). Worktrees with only untracked files, such as local `.pi-subagents/` runtime artifacts, are treated as removable and removed with `git worktree remove --force`.
4. Deletes the matching local branch after the worktree is removed.
5. Runs `git worktree prune`.

Git commands run asynchronously through Pi's abortable process API. Local commands time out after 15 seconds, network fetch/pull commands after 60 seconds, and interactive credential prompts are disabled. The command reports fetch, pull, and removal progress and clears its status on success, failure, cancellation, or session shutdown.

It skips the current worktree by default, worktrees with tracked modifications, and worktrees not merged or patch-equivalent to `origin/main`. Untracked-only worktrees are not skipped.

Options:

- `/cleanup --dry-run` or `/cleanup -n` — show planned commands without changing anything.
- `/cleanup --main trunk` — use a different main branch name.
- `/cleanup --force-current` — allow removing the current worktree if it is clean and merged.
