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

1. **Check the repo is served.** Resolve the repo; confirm a profile exists: `grep -l "PI_WORKER_REPOSITORY=<owner/repo>$" ~/.config/pi-issue-worker/*.env`. If none, stop and say so — give the one-line fix (copy an existing profile, change `PI_WORKER_REPOSITORY`/`_URL`, `chmod 600`, then `systemctl --user restart pi-issue-worker-supervisor`). Also check `systemctl --user is-active pi-issue-worker-supervisor`; if inactive, say the issue will wait until it's started.
2. **Write a self-contained issue.** Pi starts with zero context, so the body must stand alone:
   - **Goal** — one or two sentences.
   - **Context** — relevant files/modules (paths), existing patterns to follow, links to the design/plan doc on the branch if there is one (or paste its key decisions).
   - **Acceptance criteria** — a checklist pi can verify (behavior, tests to add, routes/screens).
   - **Out of scope** — what not to touch.
   - **How to verify** — commands to run; for UI, the route and what to see.
   No secrets, no local-only paths outside the repo.
3. **Create it:** `gh issue create --repo <repo> --title "<imperative title>" --body-file <tmp> --label pi-ready` (or `pi-plan`; add `pi-visual` if requested). The labels exist once the worker has polled the repo once; if `gh` reports a missing label, create the issue without it and add the label right after the next poll, or tell the user.
4. **Report** the issue URL and what happens next: pi claims it (`pi-working`), opens a draft PR (`pi-pr-open`), or asks for help (`pi-blocked`). On the PR, steer it with comments starting `/pi` — e.g. `/pi fix <what>`, `/pi retry`, `/pi verify visual`, `/pi stop`. When the draft PR is ready, `/ship` on its branch (or a normal review) takes it to merge-ready.
