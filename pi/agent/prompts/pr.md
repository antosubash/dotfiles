---
description: Prepare and open a GitHub pull request
argument-hint: "[base branch or guidance]"
---
Prepare and open a GitHub pull request for the current branch. ${ARGUMENTS:-Infer the base branch and PR metadata from the repository.}

Read the repository instructions. Inspect branch status, commits, and the complete diff against the base branch. Run appropriate validation and identify any unrelated or accidental changes. Draft a concise title and body containing the motivation, key changes, and tests. Push the current branch if needed, without force-pushing, then create the PR with `gh`.

Do not merge the PR. Report the PR URL and any validation gaps or follow-up work.
