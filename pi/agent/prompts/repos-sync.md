---
description: Sync repositories and report repositories requiring human attention
argument-hint: "[--dry-run] [--prune-worktrees] [--jobs N] [repo...]"
---

Resolve the script from the configured or current dotfiles checkout, never from a hardcoded home-directory path:

```bash
DOTFILES_CHECKOUT="${DOTFILES_DIR:-}"
if [ -z "$DOTFILES_CHECKOUT" ] || [ ! -x "$DOTFILES_CHECKOUT/scripts/repos-sync.sh" ]; then
    DOTFILES_CHECKOUT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "$DOTFILES_CHECKOUT" ] || [ ! -x "$DOTFILES_CHECKOUT/scripts/repos-sync.sh" ]; then
    printf '%s\n' 'Cannot locate scripts/repos-sync.sh in DOTFILES_DIR or the current checkout.' >&2
    exit 1
fi
"$DOTFILES_CHECKOUT/scripts/repos-sync.sh" $ARGUMENTS
```

Report the result. Do not reimplement the script or try to fix repositories it safely skipped.

Summarize updated, switched, current, and dirty-skipped counts. Highlight `diverged`, `error`, `locked`, `no-remote`, and `no-upstream` states. If removable worktrees are reported and `--prune-worktrees` was not supplied, list them and ask before rerunning with that flag.
