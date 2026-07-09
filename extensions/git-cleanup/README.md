# git-cleanup

Adds `/cleanup` for the common post-merge repo housekeeping flow.

The command:

1. Finds the repository's `main` worktree.
2. Runs `git fetch origin main --prune` and `git pull --ff-only origin main` there.
3. Removes clean non-main worktrees whose HEAD is already merged into `origin/main`.
4. Deletes the matching local branch after the worktree is removed.
5. Runs `git worktree prune`.

It skips the current worktree by default, dirty/untracked worktrees, and worktrees not merged into `origin/main`.

Options:

- `/cleanup --dry-run` or `/cleanup -n` — show planned commands without changing anything.
- `/cleanup --main trunk` — use a different main branch name.
- `/cleanup --force-current` — allow removing the current worktree if it is clean and merged.
