# git-cleanup

Adds `/cleanup` for the common post-merge repo housekeeping flow.

For compatibility with RPC clients that wait for Pi's agent lifecycle, `/cleanup` starts an agent turn that invokes the `git_cleanup` tool. This also makes RPC agent cancellation reach the Git process. The extra model turn is a temporary workaround for the [Paseo extension-command lifecycle issue](../../docs/paseo-extension-command-lifecycle.md).

After the deterministic cleanup call, the agent investigates each labeled skipped worktree with read-only Git, filesystem-metadata, and GitHub/GitLab commands. It reports **safe to remove**, **don't remove yet**, or **uncertain** with structured evidence and retains the raw cleanup reason as secondary detail. Evidence includes exact-HEAD/history recoverability from remote refs; PR/MR state, target, and clickable URL; and each non-ignored untracked artifact's type, size, mtime, and committed/remote/explicit-backup status. A safe recommendation requires recovery evidence for every local commit and meaningful untracked artifact; a closed PR/MR alone is insufficient. The analyzer does not print artifact or ignored-secret contents. This phase never removes a skipped worktree—the user must explicitly follow up with its label.

The tool is intentionally designed for a single-user local workflow:

1. It must be invoked from the repository's stable primary checkout. Invocation from a linked worktree fails with the primary path to use instead.
2. `main` must either be checked out in the primary checkout or be available there while the primary checkout is on an eligible `plan/<slug>` branch. Unexpected layouts, detached HEAD, and non-planning primary branches fail with recovery instructions.
3. Before fetching or mutating anything, it reads the status and untracked/ignored paths of every worktree. An unreadable status fails the operation rather than being treated as clean.
4. A live run fetches `origin/main`; a dry-run reads the current remote OID and downloads missing objects without updating local refs or `FETCH_HEAD`.
5. Local `main` must be fast-forwardable. The primary checkout must have no tracked changes, and untracked or ignored content that would be overwritten by switching or fast-forwarding is preserved with an error.
6. If the primary checkout is on a merged or patch-equivalent `plan/<slug>` branch, cleanup switches it back to `main`, fast-forwards, and deletes the planning branch. Other branches are never displaced automatically.
7. Linked worktrees are eligible when their HEAD is merged, their merge-free commit range is patch-equivalent to remote main, or GitLab reports an exact-HEAD merge request as merged into the configured main branch. GitLab evidence is accepted only when the MR source branch and exact source HEAD match and there is no open or closed-unmerged MR for that same exact HEAD. An unavailable or failed `glab` lookup is not treated as merge evidence. Merge-containing ranges are not accepted through patch equivalence because `git cherry` cannot prove unique merge-resolution content is upstream.
8. Tracked changes and non-ignored untracked content are always preserved. Once merge is proven, all Git-ignored content is treated as disposable and removed with `git clean -dfX`; cleanup never uses blanket `git clean -x` or `git worktree remove --force`. `.pi-subagents/` runtime state is also disposable even when it is not ignored.
9. Merge proof is established before ignored artifacts are cleaned. Cleanup then uses normal `git worktree remove`, deletes the local branch, prunes stale worktree metadata, and leaves the primary checkout on `main`.

Concurrent external Git or filesystem mutation during cleanup is out of scope. The command makes its safety decisions from the preflight snapshot and relies on Git's normal non-force checks; callers should not edit worktrees or refs while it runs.

Git commands run asynchronously through Pi's abortable process API. Local commands time out after 15 seconds, network commands after 60 seconds, and interactive credential prompts are disabled. Progress/status is cleared on success, failure, or cancellation.

The implementation requires a Git version whose `git switch` supports `--no-overwrite-ignore`. Unsupported Git fails rather than silently falling back to overwrite-prone behavior. GitLab squash-merge detection additionally requires an authenticated `glab`; cleanup remains conservative when it is absent or cannot query the current project.

**Ignored-file contract:** `.gitignore` is the repository's declaration that matching worktree content is reproducible or otherwise disposable after merge. This includes ignored local secrets such as `.env`, keys, or credentials. Keep meaningful local-only data outside removable worktrees or leave it non-ignored so cleanup preserves the worktree.

Skipped worktrees receive per-result labels (`[A]`, `[B]`, …, `[AA]`) in worktree-list order. Each reason identifies the blocking merge proof or local changes and states the corresponding data-loss risk. Labels are stable within that result and conversation so a follow-up can refer to one worktree without applying a force action to every skipped worktree.

Options:

- `/cleanup --dry-run` or `/cleanup -n` — query current remote main and show the resulting plan without changing worktrees, branches, HEAD, `FETCH_HEAD`, or refs (missing commit objects may be downloaded).
- `/cleanup --main trunk` — use a different main branch name.
- `/cleanup --force-current` — retained for argument compatibility; the supported lifecycle requires invocation from the primary checkout, which is never removed.
