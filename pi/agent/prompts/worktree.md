---
description: Create, select, or inspect the worktree used for development
argument-hint: "<task or branch> [--worktree PATH] [--no-worktree]"
---

Read the `worktree-first` skill completely and resolve `WORK_CWD` for `$ARGUMENTS`.

Do not edit project files, commit, push, or remove any worktree. If a clean primary checkout needs isolation, fetch and create the unique branch/path from `origin/<default-branch>` exactly as specified by the skill; never use current `HEAD` or a local branch as its base. If the primary checkout is dirty, stop rather than stashing, copying, or auto-committing it.

Verify the selected path is registered, identify its branch and HEAD, and print:

- absolute `WORK_CWD`;
- branch, resolved origin default branch, and fetched starting commit;
- whether it was created or reused;
- an exact `cd` command for opening a fresh Pi session there;
- existing dirty state, if any.

Preserve the worktree for subsequent `/implement`, `/loop`, `/qa`, `/ship`, `/vf`, `/commit`, or `/pr` commands.
