# repos-sync — design

Date: 2026-07-27

## Problem

`~/Repos` holds 42 git repositories and ~118 extra git worktrees. Two chores
recur constantly and are tedious by hand:

1. Bringing every repo up to date and back onto its default branch, without
   ever risking uncommitted work.
2. Removing agent worktrees under `<repo>/.claude/worktrees/` whose work has
   already landed.

The default branch is not uniform: `IIASA.GeoWiki`, `geo-wiki-v2-app`,
`abp-react-tanstack` and `laco-wiki-v2` default to `dev`; `antosubash` and
`IIASA.WEED.Web` to `master`; the rest to `main`. `GeoTrees` has no
`origin/HEAD` set at all.

## Goals

- One command that syncs every repo under a root directory.
- Never destroy uncommitted, unpushed, or unlanded work. A repo or worktree
  that cannot be handled safely is reported and left exactly as found.
- Remove worktrees whose branch has fully landed, including via squash merge.
- Deterministic and fast enough to run daily.

## Non-goals

- Pushing, committing, stashing, or resolving conflicts.
- Rewriting history, rebasing, or any non-fast-forward integration.
- Touching repos outside the root directory, or nested repos below the first
  level.

## Deliverables

| File | Purpose |
|---|---|
| `scripts/repos-sync.sh` | The implementation. Bash, git-only, no other deps. |
| `.claude/commands/repos-sync.md` | Slash command wrapper (`~/.claude/commands` symlinks to `~/dotfiles/.claude/commands`). |
| `shell/aliases.zsh` | `repos-sync` and short `rs` aliases, following the existing `UPDATE_SCRIPT` pattern. |
| `scripts/tests/test-repos-sync.sh` | Tests using the existing `scripts/tests/lib.sh` harness. |

## CLI

```
repos-sync [options] [repo…]

  --prune-worktrees   Actually remove removable worktrees (default: list only)
  --dry-run           Report everything, change nothing
  --jobs N            Parallel fetches (default 8)
  --root DIR          Workspace root (default ${REPOS_ROOT:-$HOME/Repos})
  -h, --help          Usage

Positional arguments limit the run to the named repos.
```

Default behaviour: sync actions run for real (they are non-destructive);
worktree removals are listed but not performed until `--prune-worktrees`.

## Repo discovery

Direct children of the root that contain a `.git` file or directory. No
recursion — worktrees live under `<repo>/.claude/worktrees/` and are reached
through `git worktree list` on their parent repo, never by directory scan.

## Sync algorithm, per repo

Phase 1 runs `git fetch --all --prune --prune-tags` across repos with up to
`--jobs` in flight. `--prune` is what makes deleted upstream branches
detectable in phase 3. Phase 2 runs sequentially per repo:

1. If `origin/HEAD` is unset, run `git remote set-head origin --auto`. This
   repairs `GeoTrees`.
2. Resolve `default` from `origin/HEAD`. If there is no `origin` remote,
   report `NO-REMOTE` and stop for this repo.
3. If `git status --porcelain` is non-empty, report `SKIPPED (dirty)` and make
   no working-tree change. The fetch in phase 1 has already happened and is
   safe.
4. If `default` is checked out in one of this repo's own worktrees, report
   `SKIPPED (default checked out elsewhere)` and stop — `git switch` would
   fail anyway.
5. If the current branch is not `default`, `git switch default`. If no local
   `default` exists, create it tracking `origin/default`.
6. `git merge --ff-only origin/default`. Success reports `UPDATED` or
   `UP-TO-DATE`; failure means local commits have diverged, which reports
   `DIVERGED` and leaves the repo untouched.

Switching away from a feature branch is lossless: the branch ref and its
commits remain. A detached but clean HEAD is switched to `default` normally.

## Worktree cleanup, per repo

`git worktree prune` runs first in every mode. It only drops registrations for
directories that no longer exist and touches nothing on disk.

Each remaining worktree other than the repo's main working tree is then
classified. A worktree is **kept**, with a reason, if any of these hold:

- `git status --porcelain` is non-empty (this counts untracked files).
- Its HEAD is detached.
- Its branch is the repo's default branch.

An otherwise-clean worktree on branch `B` is **removable** if any of:

1. **Ancestor merged** — `git merge-base --is-ancestor B origin/default`
   succeeds. Covers merge-commit and rebase-merge PRs, and branches that never
   diverged.
2. **Squash merged** — the branch's whole diff is already present in the
   default branch:

   ```sh
   mb=$(git merge-base origin/$default $B)
   dangling=$(git commit-tree "$B^{tree}" -p "$mb" -m _)
   git cherry origin/$default "$dangling"   # a "-" prefix means already applied
   ```

   This rebuilds `B`'s tree as a single synthetic commit off the merge-base and
   asks whether that patch is already applied. It matches squash-merged PRs,
   which ordinary ancestry checks miss.
3. **Upstream gone, nothing local-only** — `B` had an upstream, the
   remote-tracking ref is absent after the pruning fetch, and
   `git rev-list --count B --not --remotes` is `0`, so every commit on `B`
   also exists on some remote branch.

Predicate 2 is the load-bearing one here. Measured across the current
workspace: 118 extra worktrees, of which 80 are clean. Ancestry alone makes 3
removable; adding squash detection makes 47 removable. The remaining 71 are
kept — 38 dirty (20 with tracked edits, 18 with only untracked files), 32
clean but genuinely unmerged, and 1 clean but detached.

Removal is `git worktree remove <path>` with no `--force`, so git re-checks
for modifications and aborts by itself if anything changed between
classification and removal. The orphaned local branch is then deleted with
`git branch -d`, falling back to `git branch -D` only when predicate 2 or 3
matched, since `-d` refuses branches that are not ancestors by design.

Ignored files inside a removed worktree (`node_modules`, `.venv`, `bin/`,
`obj/`) go with the directory. They are regenerable build state, not work.

## Output

One line per repo with its action, then any removable worktrees indented
beneath it, then a summary:

```
38 updated · 12 skipped (dirty) · 1 diverged · 47 worktrees removable
```

With `--prune-worktrees` the last field reads `47 worktrees removed`. Exit
status is 0 unless the script itself failed; skipped repos are a normal
outcome, not an error.

## Slash command

`.claude/commands/repos-sync.md` runs the script, summarizes the result, and
offers to re-run with `--prune-worktrees` when removable worktrees were found.
It does not reimplement any git logic.

## Testing

`scripts/tests/test-repos-sync.sh` follows the `lib.sh` contract: set
`SCRIPT`, source the harness, drive with `setup_test` / `teardown_test` and
`assert_*`, end with `summary`. Each test builds throwaway bare "remotes",
clones and worktrees under `mktemp -d`, so no network and no real repos are
involved.

Cases:

- A dirty repo is left on its branch with its changes intact.
- A clean repo on a feature branch ends up on the default branch, with the
  feature branch ref still present.
- A behind repo fast-forwards; an up-to-date repo reports so.
- A diverged repo is reported and left unmoved.
- A repo whose `origin/HEAD` is unset gets it set and syncs.
- `master`- and `dev`-defaulting repos work, not just `main`.
- A squash-merged clean worktree is removed and its branch deleted.
- A dirty worktree, an untracked-only worktree, and a clean unmerged worktree
  are all kept.
- Default mode lists removable worktrees without removing them;
  `--prune-worktrees` removes them.
- `--dry-run` changes nothing at all.

## Risks

- **Squash detection false positive.** Would require a branch whose full tree
  diff against the merge-base is already applied to the default branch while
  the branch is still wanted. In that case the content is in the default
  branch anyway, so nothing is lost.
- **`commit-tree` writes objects.** The synthetic commits are unreferenced and
  are collected by routine `git gc`.
- **Concurrent editing.** A worktree modified between classification and
  removal is protected by `git worktree remove` refusing without `--force`.
