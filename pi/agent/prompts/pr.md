---
description: Prepare and open a GitHub pull request
argument-hint: "[base branch or guidance]"
---
Prepare and open a GitHub pull request for the current branch. ${ARGUMENTS:-Infer the base branch and PR metadata from the repository.}

Read the repository instructions first. This standalone workflow is gated: stop at the first failed safety or validation check and do not push or create a PR.

## Safety gates

1. Resolve `BRANCH=$(git branch --show-current)` and the requested base. Prefer an explicit base argument; otherwise use `origin/HEAD` and then `main`/`master`. Refuse a detached HEAD and refuse when `BRANCH` is the base branch. Require an `origin` remote and successfully fetch `origin/<base>` before inspecting or pushing. Refuse if `origin/<base>` does not exist.
2. Require a non-empty intended diff: inspect `git diff --check`, `git diff --stat origin/<base>...HEAD`, `git diff --name-status origin/<base>...HEAD`, and the complete patch. Refuse when there are no commits/diff to ship. Review every changed path for accidental or unrelated changes and stop for clarification rather than silently including them.
3. Refuse secret-like paths and contents. Check both the committed base-to-head diff and any working-tree/index paths for `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, token/secret files, and obvious credential material. Never stage, commit, or upload a secret while investigating it.
4. Run the repository's required validation (tests first, then relevant lint, typecheck, build, and other project checks). Record each command and result. A failed, unavailable, or skipped required check is a gate failure; do not open a PR.
5. Require a clean tree before pushing: `git status --short --untracked-files=all` must be empty after validation. Do not auto-stage or hide dirty changes. Recheck the intended diff and secret paths after validation because checks can generate files.
6. Check GitHub before pushing: run `gh auth status`, then `gh pr list --state open --head "$BRANCH" --json number,url,baseRefName --limit 20` and verify every result's base. Refuse if more than one open PR exists. If exactly one matching open PR already exists, report it and do not create a duplicate; if an open PR targets another base, stop for manual resolution. This workflow creates at most one PR.

## Push and create

Draft a concise title and body containing motivation, key changes, the complete validation results, and any known follow-up. Show the final diff summary and proposed metadata before network mutation. Push only with:

```bash
git push -u origin HEAD
```

Never use `--force`, `--force-with-lease`, `-f`, a force-push alias, or a destructive reset. After pushing, recheck the branch, clean tree, origin/base diff, and one-open-PR invariant. Create exactly one PR with `gh pr create --base <base>` only when all gates pass. Do not merge the PR.

Report the existing or newly created PR URL, branch/base, intended diff summary, every validation command/result, and any gate that prevented pushing or PR creation. Never invent a URL.
