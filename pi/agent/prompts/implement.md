---
description: Scout, plan, and implement a task in an isolated worktree
argument-hint: "<task> [--worktree PATH] [--no-worktree]"
---

Implement `$ARGUMENTS` with a worktree-first subagent chain.

Before inspecting or editing, read the `worktree-first` skill completely. Parse `--worktree PATH` and `--no-worktree`, remove those flags from the task text, and resolve `WORK_CWD` using that skill. A clean primary checkout fetches and creates a new linked worktree from `origin/<default-branch>` by default, never from current `HEAD` or a local branch; a dirty primary checkout is never stashed, copied, or auto-committed. Print the selected worktree and branch.

Use the `subagent` tool in chain mode with `cwd=WORK_CWD` for every step:

1. `scout`: inspect project instructions, repository status, relevant code, and tests.
2. `planner`: create a concrete minimal plan for the original task using `{previous}` reconnaissance.
3. `worker`: implement the original task using `{previous}` plan, preserve unrelated changes, and run targeted validation. State explicitly whether worktree isolation is active or the user supplied `--no-worktree`.

After the chain finishes, inspect the resulting diff and run missing targeted checks from `WORK_CWD`. Do not commit or push. Preserve the worktree for resume/audit and summarize its absolute path, branch, changed files, validation, and remaining risks.
