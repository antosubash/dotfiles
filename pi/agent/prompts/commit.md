---
description: Review, validate, and commit the current task
argument-hint: "[commit guidance] [--worktree PATH] [--no-worktree]"
---
Prepare and create a git commit for the current task. ${ARGUMENTS:-Use a concise Conventional Commit message consistent with repository history.}

Read the `worktree-first` skill and repository instructions. Parse `--worktree PATH` and `--no-worktree`; require an existing linked worktree by default because pending changes must never be moved, stashed, or copied automatically. Use the selected `WORK_CWD` for every status, diff, validation, staging, and commit command. If invoked from a dirty primary checkout without an explicit opt-out, stop with safe migration/checkpoint guidance.

Inspect status, staged changes, unstaged changes, and the relevant diff. Preserve unrelated work and never stage secrets, generated credentials, or unrelated files. If the intended commit scope is ambiguous, ask before staging. Run appropriate targeted validation, stage only task-related changes, review the final staged diff, and create the commit. Do not push.

Report the commit hash, subject, included files, validation results, and preserved worktree path/branch (or explicit primary-checkout opt-out).
