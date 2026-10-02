---
description: Set up (or check) the background pi issue worker for a repo — installs the worker if needed, creates the repo's profile, verifies GitHub access and the pi login, starts the supervisor, and confirms it's polling. Also lists every repo pi serves.
argument-hint: [OWNER/REPO | path] [--app-url URL] [--status]
allowed-tools: Bash, Read, Glob, Grep
---

# /pi-setup — Put the pi issue worker on a repo

User invoked with: `$ARGUMENTS`

- **Repo** — `OWNER/REPO`, a local path, or nothing (the current repo's `origin`).
- `--app-url URL` — where the app runs locally, used by pi for browser verification. If omitted, take the port from the repo's `running-the-stack` skill or CLAUDE.md when one is named; otherwise leave it unset.
- `--status` — don't change anything; list the repos pi serves and whether the service is healthy.

## `--status`

1. For each `~/.config/pi-issue-worker/*.env`, print the profile name and its `PI_WORKER_REPOSITORY` (never print other values, especially tokens).
2. Run `systemctl --user is-active pi-issue-worker-supervisor`, then `journalctl --user -u pi-issue-worker-supervisor -n 30 --no-pager` filtered to `error|blocked|exited|starting`.
3. For each repo, count its issues and PRs by label: `gh issue list -R <repo> --label pi-working|pi-blocked|pi-pr-open`.
4. Report one line per repo, then stop.

## Setup

1. Resolve `OWNER/REPO`: from the argument, from `git -C <path> remote get-url origin`, or from the current directory.
2. Run `~/dotfiles/scripts/pi-worker-ensure.sh <OWNER/REPO> [--app-url URL]` (timeout 300000). It is idempotent:
   - installs the worker if needed;
   - creates `~/.config/pi-issue-worker/<repo>.env` from an existing profile, with the repository, URL and default branch set, sandbox off, and no inherited token or data directory;
   - runs the read-only check;
   - starts or restarts the supervisor (in-flight jobs on other repos resume);
   - waits until the worker has created its `pi-*` labels on the repo.
3. If it fails, fix what it reports when you can, then rerun it:
   - pi login expired: run any `pi -p "ok"` call to refresh it;
   - `gh` lacks access: tell the user;
   - install error: rerun `scripts/setup-pi-issue-worker.sh` to see it.

   For anything only the user can do (sudo, an interactive `pi` login), give the exact `!` command and stop.
4. **Report:**
   - the profile file path;
   - the base branch;
   - the app URL, if set;
   - that the worker is polling the repo.

   Then explain how to use it: `/handoff <task>` creates a `pi-ready` issue, or you can label any well-specified issue `pi-ready` (or `pi-plan` for a plan only). Steer draft PRs with `/pi fix …`, `/pi retry` and `/pi stop`.
5. **Optional QA manifest:** if the repo is a runnable app and has no `.pi-worker/qa.json`, mention that adding one lets pi start the app and verify it in the browser. The format is in `~/dotfiles/pi/github-issue-worker/README.md` under "QA manifest". Don't create it unasked.

To stop serving a repo, delete its profile and run `systemctl --user restart pi-issue-worker-supervisor`.
