---
description: Sync repositories and report repositories requiring human attention
argument-hint: "[--dry-run] [--prune-worktrees] [--jobs N] [repo...]"
---

Run `~/dotfiles/scripts/repos-sync.sh $ARGUMENTS` and report the result. Do not reimplement the script or try to fix repositories it safely skipped.

Summarize updated, switched, current, and dirty-skipped counts. Highlight `diverged`, `error`, `locked`, `no-remote`, and `no-upstream` states. If removable worktrees are reported and `--prune-worktrees` was not supplied, list them and ask before rerunning with that flag.
