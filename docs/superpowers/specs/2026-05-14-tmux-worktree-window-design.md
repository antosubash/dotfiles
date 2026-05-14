# tmux worktree window — design

## Goal

Add a new tmux keybinding that, when invoked from inside a git repo, prompts for a branch name and opens a new tmux window in a corresponding git worktree. The worktree is created on demand or reused if it already exists. The existing `prefix + c` binding is untouched.

## User flow

1. User is in a tmux pane whose `pane_current_path` is somewhere inside a git repository.
2. User presses `prefix + g`.
3. tmux shows a `branch:` prompt at the status line.
4. User types a branch name (e.g., `feature/foo`) and hits Enter.
   - Empty input cancels — no window is opened.
5. A new tmux window opens, named after the sanitized worktree name (e.g., `feature-foo`), with its working directory set to that worktree.

If invoked outside a git repo: tmux shows `not a git repo` via `display-message` and does nothing.

## Keybinding

In `tmux/.tmux.conf`, add (without modifying any existing binding):

```
bind g run-shell "~/dotfiles/scripts/tmux-worktree-window.sh prompt '#{pane_current_path}'"
```

`prefix + c` and all other bindings remain as-is.

## Worktree naming and location

- **Branch name**: whatever the user typed, used verbatim with git.
- **Worktree name** (= tmux window name = directory name under `.worktrees/`): sanitized branch name.
  - Sanitization: replace `/` with `-`; replace any character outside `[A-Za-z0-9._-]` with `-`; collapse runs of `-`; trim leading/trailing `-`.
  - Example: `feature/foo` → `feature-foo`. `bugfix/ABC-123` → `bugfix-ABC-123`.
- **Worktree path**: `<main-repo-toplevel>/.worktrees/<sanitized>`
  - "Main-repo-toplevel" means the common working directory of the repo, not the toplevel of whatever worktree the user happens to be in. This is computed as the parent of `git rev-parse --path-format=absolute --git-common-dir` (which points at `<main>/.git`). This way, invoking the binding from inside an existing worktree still creates the new worktree under the original repo's `.worktrees/`, keeping all worktrees siblings.

## Branch resolution

When the worktree path doesn't yet exist, resolve the branch in this order:

1. Local branch exists (`git show-ref --verify --quiet refs/heads/<branch>`)
   → `git worktree add <path> <branch>`
2. Remote branch exists on `origin` (`git show-ref --verify --quiet refs/remotes/origin/<branch>`)
   → `git worktree add -b <branch> <path> origin/<branch>`
3. Otherwise (new branch)
   → `git worktree add -b <branch> <path>`

If the worktree path already exists on disk, skip resolution and just open a window there. This makes the binding idempotent — pressing it again with the same branch name simply re-opens the existing worktree.

## Helper script

New file: `scripts/tmux-worktree-window.sh`. POSIX `sh`, executable.

Two subcommands so the prompt callback can pass user input safely without shell quoting hazards:

- `tmux-worktree-window.sh prompt <pane_current_path>`
  - Validates the path is in a git repo. If not, `tmux display-message "not a git repo"` and exit 0.
  - Issues `tmux command-prompt -p "branch:" "run-shell 'SCRIPT spawn <pane_current_path> %%'"` (with the script path and pane path properly escaped).

- `tmux-worktree-window.sh spawn <pane_current_path> <branch>`
  - If `<branch>` is empty, exit silently (cancelled prompt).
  - Compute sanitized name and worktree path.
  - Compute main-repo toplevel via `git -C <pane_current_path> rev-parse --path-format=absolute --git-common-dir`, then `dirname` that.
  - If worktree path doesn't exist, run the appropriate `git worktree add` (resolution order above). On failure, capture stderr and `tmux display-message` it; do not open a window.
  - On success (or if path already existed), run `tmux new-window -n <sanitized> -c <worktree-path>`.

The script never writes to stdout in normal operation (all user-facing messages go through `tmux display-message`).

## Error and edge cases

| Situation | Behavior |
|---|---|
| Not in a git repo | `display-message "not a git repo"`, no window |
| Empty branch input | Silent cancel, no window |
| Branch name with `/` | Used verbatim with git; sanitized for path/window name |
| Branch name with shell-unsafe chars (spaces, `$`, etc.) | Sanitized to `-`; if the resulting name is empty, `display-message "invalid branch name"`, no window |
| Worktree path already exists | Open a window there (idempotent reuse) |
| `git worktree add` fails (dirty state, locked, etc.) | `display-message` with the git error; no window |
| Invoked from inside a nested worktree | New worktree is still placed under the main repo's `.worktrees/` |
| Bare repo / no commits yet | `git worktree add` will fail; error is displayed via `display-message` |

## Files changed

- **New**: `scripts/tmux-worktree-window.sh` (executable, POSIX `sh`)
- **Edit**: `tmux/.tmux.conf` — add one `bind g` line

No changes to `shell/tmux-aliases.sh` or any other file.

## Out of scope

- Listing or switching between existing worktrees (no picker).
- Pruning or deleting worktrees.
- Auto-adding `.worktrees/` to any `.gitignore`. Users can do this globally if they want.
- Configuring the keybinding key — `prefix + g` is hardcoded.
- Customizing the worktree location pattern.
