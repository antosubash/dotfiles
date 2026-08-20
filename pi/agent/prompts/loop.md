---
description: Implement, review, and fix in an isolated worktree until clean or bounded
argument-hint: "<task> [--max-iterations N] [--worktree PATH] [--no-worktree]"
---

Run a bounded implementation convergence loop for `$ARGUMENTS`.

Default `max_iterations` to 3. Before inspection or edits, read the `worktree-first` skill completely. Parse `--worktree PATH` and `--no-worktree`, remove workflow flags from the task text, and resolve `WORK_CWD` using that skill. A clean primary checkout fetches and creates a linked worktree from `origin/<default-branch>` by default, never from current `HEAD` or a local branch; never stash, copy, or auto-commit a dirty primary checkout. Print the selected worktree and branch.

1. From `WORK_CWD`, inspect repository instructions and status. Preserve unrelated work.
2. Dispatch `worker` with `cwd=WORK_CWD` to implement the task and run targeted checks. State whether worktree isolation is active or the user explicitly opted out.
3. Dispatch `reviewer` with `cwd=WORK_CWD` to review the complete task diff plus uncommitted changes.
4. If its final line is `VERDICT: CLEAN`, run the relevant validation yourself from `WORK_CWD` and stop successfully.
5. If findings remain, dispatch `worker` with `cwd=WORK_CWD` and the exact review output, then return to step 3.
6. Stop after `max_iterations`; report unresolved findings rather than claiming success.

Do not commit, push, or silently fall back to the primary checkout. A fix pass is never proof of cleanliness: always perform the next review pass. Preserve and report the worktree path and branch in the final summary.
