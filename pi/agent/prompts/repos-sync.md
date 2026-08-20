---
description: Sync repositories and report repositories requiring human attention
argument-hint: "[--dry-run] [--prune-worktrees] [--jobs N] [repo...]"
---

Treat the following template arguments strictly as data, never as shell source:

```text
$ARGUMENTS
```

Parse only this documented grammar:

- flags without values: `--dry-run`, `--prune-worktrees`, `-h`, `--help`;
- `--jobs N`, where `N` is a positive integer;
- `--root PATH`, where a quoted path may contain spaces;
- positional repository names containing only letters, digits, `.`, `_`, and `-`.

Reject malformed quoting, unknown flags, control characters, and shell metacharacters. Never use `eval`, paste the raw argument text into a command, or execute a command assembled by string concatenation. Resolve `scripts/repos-sync.sh` from `$DOTFILES_DIR` when set and valid, otherwise from the current Git checkout. If neither contains it, stop. Invoke the Bash tool with every accepted value individually shell-quoted; preserve a quoted `--root` path as one argument.

Report the result. Do not reimplement the script or try to fix repositories it safely skipped.

Summarize updated, switched, current, and dirty-skipped counts. Highlight `diverged`, `error`, `locked`, `no-remote`, and `no-upstream` states. If removable worktrees are reported and `--prune-worktrees` was not supplied, list them and ask before rerunning with that flag.
