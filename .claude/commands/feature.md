---
description: Take a feature from idea (free text or a GitHub issue) to a merge-ready PR with a single human checkpoint — one batch of questions, one design approval, then plan → subagent implementation in a worktree → /ship, without stopping in between.
argument-hint: <feature description | issue URL | #issue> [--base BRANCH] [--yes] [--no-ship] [--no-pr] [--skip-browser] [--ship-args "..."]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, EnterWorktree, Monitor
---

# /feature — Idea → merge-ready PR with one checkpoint

You are the lead engineer. The user wants to hand you a feature and come back to a PR. Everything between the design approval and the PR runs **without stopping**.

```
 0 Preflight ─► 1 Understand ─► 2 Questions (one batch, optional) ─► 3 Design ─► ✋ ONE APPROVAL
                                                                                       │
                     5 Implement (subagents, worktree, TDD) ◄─ 4 Spec + Plan ◄─────────┘
                                   │
                                   ▼
                              6 /ship ─► PR
```

## Arguments

User invoked with: `$ARGUMENTS`

- **Feature** — free text, a GitHub issue URL, or `#123` (read it with `gh issue view <n> --comments`; include linked images/designs in your understanding).
- `--base BRANCH` — base branch (default `main`, else `master`).
- `--yes` — skip the design approval gate (small, low-risk features). Questions are still asked if genuinely needed.
- `--no-ship` — stop after implementation (branch committed, tests passing), don't run `/ship`.
- `--no-pr`, `--skip-browser` — passed through to `/ship`.
- `--ship-args "..."` — any extra flags for `/ship` (e.g. `--depth deep --a11y`).

## Hard Rules

- **Exactly two possible human stops before the PR:** the question batch (Stage 2, only if needed) and the design approval (Stage 3, unless `--yes`). After approval, the only allowed stops are genuine blockers that need a human (sudo, a login, a secret, a missing external resource) or a design-breaking discovery (see Stage 5).
- **Never present the design section by section.** One message, the whole design, one approval. This replaces the section-by-section flow of `superpowers:brainstorming`. If that skill fires, follow its exploration discipline but use this single-approval gate.
- **Approval of the design = approval of the spec, plan, and implementation.** Don't ask again before writing the plan or starting to code.
- **Work in a worktree** off a freshly fetched `origin/<base>`. Never touch the user's primary checkout.
- **Never push to the base branch, never force-push, never merge.** `/ship` (via `/vf`) opens the PR.
- **State on disk.** Keep `$(git rev-parse --git-common-dir)/feature/<slug>/state.json` updated at every stage boundary (`stage`, `branch`, `worktree`, `design_path`, `plan_path`, `tasks_done`, `blockers`). If the conversation is summarized mid-run, re-read it and resume — don't restart.
- **Use TaskCreate/TaskUpdate** for each stage so progress is visible.

## Stage 0 — Preflight

1. Confirm a git repo with an `origin` remote. Resolve the base branch. `git fetch origin <base>`.
2. Derive a short kebab-case `<slug>` from the feature (or `issue-<n>-<slug>`). Branch name: `feat/<slug>`.
3. Create the worktree from `origin/<base>` (use `EnterWorktree` if available; otherwise `git worktree add -b feat/<slug> .claude/worktrees/<slug> origin/<base>` and `cd` into it). If the branch already exists with a `state.json`, resume from its `stage` instead.
4. Look for how to run the app: a `running-the-stack` skill, `.claude/skills/*`, or a launch section in `CLAUDE.md`/`AGENTS.md`. If it's a runnable app and none exists, note it — Stage 5 will run `/runbook` once the app has been started successfully, so `/ship`'s QA stage has it.

## Stage 1 — Understand (no user interaction)

Dispatch **parallel `Explore` agents (`model: sonnet`)** — typically 2–3 — to map what the feature touches: the closest existing feature to copy patterns from, the modules/files involved, data model, tests and test helpers, UI conventions. Each returns a short structured summary with file paths, not file dumps. Read the repo's `CLAUDE.md` yourself.

From this, list every **open decision**: things the description doesn't settle that change what gets built.

## Stage 2 — Questions (one batch, only if needed)

- Resolve every decision you can from the codebase, the issue, and conventions — and record what you chose and why. These go in the design as "Decisions made".
- Only decisions that are genuinely the user's (product behavior, scope, external services, cost, irreversible data choices) become questions.
- Ask them **all in one `AskUserQuestion` call** (up to 4 questions; put the recommended option first, marked "(Recommended)"). If there are more than 4, fold the minor ones into the design as stated defaults the user can override at approval.
- No genuine questions → skip this stage entirely.

## Stage 3 — Design (one approval)

Write the full design to `docs/superpowers/specs/<YYYY-MM-DD>-<slug>-design.md` in the worktree (or the repo's existing specs/docs location if it has one). Scale it to the feature — a small feature is half a page. Cover:

- **Goal & scope** — what's in, what's explicitly out.
- **Approach** — the chosen approach and the 1–2 alternatives rejected, one line each on why.
- **Design** — data model, APIs/routes, UI/screens, permissions, background jobs — whichever apply.
- **Decisions made** — every default you picked without asking, so the user can override any of them.
- **Testing** — what gets unit/integration/e2e coverage; what QA will exercise in the browser.
- **Risks** — anything that could force a design change during implementation.

Then post **one message**: a tight summary of the design (not the whole file) with the path to the full doc, and ask for one approval:

> Approve this design to start implementation? Reply with changes, or "yes" — after that I'll plan, implement, and run /ship without stopping.

- `--yes` → don't ask; proceed.
- User requests changes → revise the doc, re-post the summary of **what changed**, ask once more.
- Approved → commit the design doc (`docs: <slug> design`) and continue immediately.

## Stage 4 — Spec + Plan (no user interaction)

Write the implementation plan with the `superpowers:writing-plans` skill (if available) to `docs/superpowers/plans/<YYYY-MM-DD>-<slug>.md`: small, ordered, independently testable tasks, each with the files to touch, the test to write first, and the done-check. Mark which tasks are independent (parallelizable) and which are hard (cross-cutting, tricky logic). **Do not ask for plan approval** — the design approval covers it. Commit the plan.

## Stage 5 — Implement (no user interaction)

Execute the plan with `superpowers:subagent-driven-development` (if available), otherwise dispatch implementer agents yourself:

- **Model routing:** routine tasks → implementer `model: sonnet`; tasks marked hard → `model: opus`; per-task spec/quality reviews → `model: sonnet`.
- Independent tasks may run in parallel **only** if they touch disjoint files; otherwise sequential.
- Each task: test first (TDD), implement, run the relevant tests, commit (`feat(<slug>): <task>`).
- After all tasks: run the full lint/typecheck/test suite. Fix failures yourself (or with a sonnet dev agent) — don't stop to report them.
- If the app is runnable: start it, wait for it with Monitor until healthy, and smoke-check the feature once. If no `running-the-stack` skill existed, run `Skill(skill="runbook")` now and commit the generated skill (`docs: add running-the-stack skill`).

**Design-breaking discovery** (the approved design can't work as written — e.g. an API doesn't exist, a constraint makes the data model wrong): stop, explain the problem and a recommended revision in one message, and ask once. Small deviations — fix and note them in the final summary instead.

Update `state.json` after every task so a resumed session picks up at the next unfinished task.

## Stage 6 — Ship

Skip if `--no-ship`. Otherwise:

```
Skill(skill="ship", args="<feature one-liner> --base <base> [--no-pr] [--skip-browser] [<--ship-args>]")
```

`/ship` takes it from here: clean-tree checkpoint, `/optimize`, code-review loop, QA, `/vf`, one PR. Pass the issue reference in the feature one-liner (e.g. `Closes #123`) so the PR links it.

## Final summary

```
/feature — <slug>
  Design:     <path>   (approved | --yes)
  Plan:       <path>   <N> tasks, all done
  Branch:     feat/<slug>   worktree <path>
  Deviations: <none | list of small deviations from the design>
  Ship:       <PR url from /ship | STOPPED: reason | skipped (--no-ship)>
```

Never invent a PR URL — only print what `/ship` returned.
