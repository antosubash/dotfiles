---
name: worktree-first
description: Establishes an isolated Git worktree before implementation, QA fixes, or shipping. Use whenever a task will edit, commit, test, or ship repository code.
---

# Worktree-first workflow

Use a linked Git worktree as the default execution directory for write-capable work. Read-only inspection may stay in the caller's checkout.

## Inputs

Workflows may accept:

- `--worktree PATH`: use an existing registered linked worktree.
- `--no-worktree`: explicit opt-out for exceptional cases.

Strip these workflow flags from the feature/task text before delegating it.

## Resolve the execution directory

1. Require a non-bare Git repository. Resolve canonical absolute values for the current top-level, `git rev-parse --absolute-git-dir`, and `git rev-parse --path-format=absolute --git-common-dir`.
2. If `--worktree PATH` was supplied, require that its canonical path appears exactly in `git worktree list --porcelain`, require that its absolute Git directory differs from the common Git directory (so the primary checkout cannot masquerade as a linked worktree), and require a branch (not detached HEAD), then set `WORK_CWD` to that path.
3. Otherwise, if the current Git directory differs from the common Git directory, the caller is already in a linked worktree. Set `WORK_CWD` to its top-level and reuse it.
4. Otherwise the caller is in the primary checkout:
   - With `--no-worktree`, set `WORK_CWD` to the current top-level and record the opt-out.
   - Without it, never stash, discard, copy, or auto-commit a dirty primary checkout. Stop and ask the user to checkpoint the intended changes or rerun explicitly with `--no-worktree`.
   - Only new implementation tasks may create a worktree. QA, commit, verification, and shipping workflows must preserve an existing feature branch, so they stop and require an already-linked worktree instead of creating a replacement.
   - For a clean new implementation, require `origin` and query the remote itself with `git ls-remote --symref origin HEAD`. Accept only one `ref: refs/heads/<name> HEAD` result; do not trust the possibly stale local `refs/remotes/origin/HEAD`, and do not guess `main` or `master`. Fetch that exact source into `refs/remotes/origin/$DEFAULT_BRANCH` immediately before creation and require the remote-tracking ref to exist.
   - Derive a short lowercase slug from the task, then claim a unique branch `pi/<slug>-YYYYmmdd-HHMMSS-$$` and path `<primary>/.worktrees/pi-<slug>-YYYYmmdd-HHMMSS-$$`. Add `/.worktrees/` to the common Git directory's `info/exclude` if absent. Refuse pre-existing branch/path collisions. Create the branch and worktree with `git worktree add -b "$WORK_BRANCH" "$WORK_CWD" "origin/$DEFAULT_BRANCH"`; never use the caller's `HEAD` or a local default branch as the start point. On failure, stop without trying a second location.
5. For a newly created implementation worktree only, verify `WORK_CWD` is registered, on the expected branch, clean, and exactly at the fetched origin default tip before delegation. For a reused linked worktree, preserve its current dirty state and feature ancestry; validate only its registration and non-detached branch. Print its absolute path and branch, plus the `origin/$DEFAULT_BRANCH` base commit when newly created.

Use `WORK_CWD` as `cwd` for every scout, planner, worker, reviewer, browser agent, shell command, test, server, and Git operation in that workflow. Never silently fall back to the primary checkout after worktree creation.

## Shipping gate

`/qa`, `/commit`, `/ship`, `/vf`, and `/pr` must normally start inside an existing linked worktree because they inspect, mutate, verify, or ship the current feature branch. If invoked from the primary checkout without `--no-worktree`, stop before committing, rebasing, pushing, or opening a PR. Report an exact safe migration command or tell the user to start the task through `/implement` or `/loop`; do not create a derived shipping branch automatically.

## Cleanup

Preserve the feature worktree by default so the user can inspect or resume it. Report its path and branch in every final summary. Remove it only on explicit request, and only after confirming it is clean and its commits are safely reachable. Never force-remove a dirty worktree.
