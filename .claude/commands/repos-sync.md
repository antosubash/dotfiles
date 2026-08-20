---
description: Sync every repo under ~/Repos to its default branch and clean up landed worktrees
---

Run `~/dotfiles/scripts/repos-sync.sh $ARGUMENTS` and report the result.

The script does all the git work. Do not reimplement any of its logic, and do
not run git commands to "fix up" repos it reported as skipped — being skipped
is the safe outcome, not a failure.

After it finishes:

1. Summarize: how many repos were updated, switched, already current, and
   skipped as dirty.
2. Call out anything in a `diverged`, `error`, `locked`, `no-remote` or
   `no-upstream` state, since those need a human decision.
3. If it reported removable worktrees and `--prune-worktrees` was not passed,
   list them and ask whether to rerun with `--prune-worktrees`. Do not pass
   that flag on your own initiative.

Useful flags: `--prune-worktrees` (actually remove landed worktrees),
`--dry-run` (change nothing), `--jobs N`, `--root DIR`. Positional arguments
limit the run to named repos.
