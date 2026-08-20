---
description: Review, validate, and commit the current task
argument-hint: "[commit guidance]"
---
Prepare and create a git commit for the current task. ${ARGUMENTS:-Use a concise Conventional Commit message consistent with repository history.}

Read the repository instructions and inspect status, staged changes, unstaged changes, and the relevant diff. Preserve unrelated work and never stage secrets, generated credentials, or unrelated files. If the intended commit scope is ambiguous, ask before staging. Run appropriate targeted validation, stage only task-related changes, review the final staged diff, and create the commit. Do not push.

Report the commit hash, subject, included files, and validation results.
