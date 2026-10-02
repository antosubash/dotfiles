---
description: Hand a well-defined task to the background pi issue worker — writes a self-contained GitHub issue (from the conversation, a /feature design, or free text) and labels it so pi implements it and opens a draft PR while you do something else.
argument-hint: [task description | path to design/plan] [--plan] [--visual] [--repo OWNER/REPO]
allowed-tools: Bash, Read, Glob, Grep
---

# /handoff — Give a task to pi

The pi issue worker (`pi-issue-worker-supervisor.service`) polls the repos that have a profile in `~/.config/pi-issue-worker/*.env`. An issue labelled `pi-ready` gets implemented in its own worktree, verified, and opened as a **draft PR**. Use this for work that's already decided: a bug with a clear repro, a scoped change, an approved `/feature` design. Keep design and open-ended work in Claude.

User invoked with: `$ARGUMENTS`

- **Task** — free text, or a path to a design/plan doc (e.g. from `/feature`). With nothing given, use the task under discussion in this conversation.
- `--plan` — label `pi-plan` instead of `pi-ready`: pi only posts an implementation plan for review; apply `pi-ready` later to start.
- `--visual` — also label `pi-visual` (pi attaches browser screenshots/GIF evidence to the PR).
- `--repo OWNER/REPO` — target repo (default: the current repo's `origin`).

## Steps

1. **Make sure pi is serving the repo — set it up if not.** Run `~/dotfiles/scripts/pi-worker-ensure.sh <owner/repo>` (timeout 300000). Add `--app-url http://localhost:<port>` if the repo's `running-the-stack` skill or CLAUDE.md names the app's port. The script is idempotent:
   - installs the worker if needed;
   - creates the repo's profile in `~/.config/pi-issue-worker/` if it's missing (sandbox off);
   - checks GitHub access, the clone and the pi login;
   - starts or restarts the supervisor (in-flight jobs resume);
   - waits until the worker has created its `pi-*` labels on the repo.

   It ends with `✓ pi worker is serving …`. If it fails, fix what it reports when you can. Common causes: pi login expired (run any `pi -p` call to refresh it), or `gh` can't access the repo. Then rerun it. Don't create the issue until it passes. If it needs something only the user can do (sudo, `pi` login), give the exact `!` command and stop.
2. **Check the task against current code first.** Fetch and read the code on `origin/<base>`, not old issue text or memory. Trace the real path end to end, including both sides of a cross-module flow, and confirm the bug still exists, or that the change is still needed. Old issues are often already fixed or describe flows that have since changed. If it's already fixed or obsolete, say so and don't create the issue.
3. **Write a self-contained issue.** Pi starts with zero context, so the body must stand alone:
   - **Goal** — one or two sentences.
   - **Context** — relevant files/modules (paths), existing patterns to follow, links to the design/plan doc on the branch if there is one (or paste its key decisions).
   - **Acceptance criteria** — a checklist pi can verify (behavior, tests to add, routes/screens).
   - **Out of scope** — what not to touch.
   - **How to verify** — commands to run; for UI, the route and what to see.
   No secrets, no local-only paths outside the repo.
4. **Create it:** `gh issue create --repo <repo> --title "<imperative title>" --body-file <tmp> --label pi-ready` (or `pi-plan`; add `pi-visual` if requested). The labels are guaranteed to exist after step 1.
5. **Report** the issue URL and what happens next: pi claims it (`pi-working`), opens a draft PR (`pi-pr-open`), or asks for help (`pi-blocked`). On the PR, steer it with comments starting `/pi` — e.g. `/pi fix <what>`, `/pi retry`, `/pi verify visual`, `/pi stop`. When the draft PR is ready, `/ship` on its branch (or a normal review) takes it to merge-ready.
