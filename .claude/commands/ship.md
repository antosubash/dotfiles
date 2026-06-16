---
description: Take a feature branch all the way to a merge-ready PR. Runs a full-convergence pipeline — loops /code-review until it reports zero findings, runs the full /qa browser cycle (which fixes bugs), then re-reviews whatever changed, repeating until a complete pass finds no review issues AND no QA bugs, and finally runs /vf to open exactly one PR. Use this whenever you want to "ship", "finalize", "wrap up", "finish", or "get this branch ready for review/merge" — i.e. do the full review + QA + verify + PR dance in one shot, not just a single review or a single QA pass.
argument-hint: [feature description] [--port N] [--route PATH] [--url URL] [--start CMD] [--base BRANCH] [--depth shallow|normal|deep] [--review-effort low|medium|high|max] [--max-outer-iterations N] [--max-review-iterations N] [--no-review] [--no-qa] [--no-pr] [--skip-browser] [--a11y] [--responsive] [--perf]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, TaskCreate, TaskUpdate, TaskList, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_hover, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_fill_form, mcp__plugin_playwright_playwright__browser_select_option, mcp__plugin_playwright_playwright__browser_press_key, mcp__plugin_playwright_playwright__browser_wait_for, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_network_request, mcp__plugin_playwright_playwright__browser_evaluate, mcp__plugin_playwright_playwright__browser_tabs, mcp__plugin_playwright_playwright__browser_navigate_back, mcp__plugin_playwright_playwright__browser_close, mcp__plugin_playwright_playwright__browser_resize, mcp__plugin_playwright_playwright__browser_file_upload, mcp__plugin_playwright_playwright__browser_handle_dialog
---

# /ship — Review → QA → Verify → PR (full-convergence pipeline)

You are a release lead taking a feature branch from "I think it's done" to a clean, merge-ready PR. You orchestrate three existing commands and loop until the branch is genuinely clean:

```
┌──────────────────────────────────────────────────────────────────────┐
│  OUTER LOOP  (repeat until a full pass is clean, or max-outer hit)     │
│                                                                        │
│   STAGE A  ── code-review loop ──►  /code-review → fix → re-review     │
│                until 0 findings (or max-review-iterations)             │
│                                                                        │
│   STAGE B  ── QA cycle ──────────►  /qa --no-vf                        │
│                full browser test + auto-fix, loops internally          │
│                                                                        │
│   CONVERGENCE CHECK                                                    │
│     review found 0  AND  qa found 0  →  CONVERGED, exit loop           │
│     anything changed                 →  outer++ , go back to STAGE A   │
└──────────────────────────────────────────────────────────────────────┘
                                  │  (converged clean)
                                  ▼
                    STAGE C  ── /vf --qa-passed ──►  local CI + ONE PR
```

The whole point: **code review and QA fix code, and fixing code can introduce new problems.** So after either one changes anything, you re-review and re-test. You only open the PR once a complete pass over the branch finds nothing left to fix.

## Arguments

User invoked with: `$ARGUMENTS`

Parse into:
- **Feature description** — free text (anything not a flag). Passed through to `/qa` and `/vf` and used in the PR body.
- `--port N`, `--route PATH`, `--url URL`, `--start CMD` — server/route hints. Passed through to `/qa` and `/vf`.
- `--base BRANCH` — base branch for rebase + PR. Passed to `/vf` (defaults: `main`, else `master`).
- `--depth shallow|normal|deep` — QA thoroughness (default `normal`). Passed to `/qa`.
- `--review-effort low|medium|high|max` — effort for `/code-review` (default `high`). Higher = broader coverage, more findings.
- `--max-outer-iterations N` — max review↔QA convergence rounds (default **3**). Each round runs a full `/qa`, so this bounds cost.
- `--max-review-iterations N` — max passes inside a single Stage A code-review loop (default **5**).
- `--no-review` — skip Stage A (the standalone code-review loop). QA still runs its own internal review gate.
- `--no-qa` — skip Stage B. Pipeline becomes: code-review loop → `/vf`. (`/vf` runs without `--qa-passed`, so it does its own smoke check.)
- `--no-pr` — run the full pipeline but pass `--no-pr` to `/vf` (verify only, no PR).
- `--skip-browser` — non-web project: skip browser QA. Implies `--no-qa` and passes `--skip-browser` to `/vf`.
- `--a11y`, `--responsive`, `--perf` — passed through to `/qa` for deeper audits.

Don't ask clarifying questions when reasonable defaults exist — echo what you detected and proceed. Ask **once** only for a value you genuinely cannot infer (e.g. a port with no detectable default).

## Hard Rules

- **This is a real loop. You keep going until an exit condition is met — never stop after one round and ask the user whether to continue.** The exit conditions are: a fully clean pass, or `max-outer-iterations` reached.
- **Exactly one PR.** `/qa` is always invoked with `--no-vf` so it never opens its own PR. Only Stage C opens a PR, and only if the branch converged clean and `--no-pr` was not passed.
- **Never open a PR with known unfixed issues.** If you hit `max-outer-iterations` with issues still open, STOP at Stage C, list what remains, and do NOT run `/vf` to create a PR.
- **Must be on a feature branch.** Refuse to run on the base branch (`main`/`master`) — `/vf` will reject it anyway, so check up front before doing expensive work.
- **Delegate, don't reimplement.** Invoke `/code-review`, `/qa`, and `/vf` via the `Skill` tool. Do not hand-roll your own QA or PR logic — these commands already encode it.
- **Read the sub-command output to make decisions.** After each `Skill` invocation, read what it returned to decide whether findings/bugs remain. That judgment drives the loop.

---

## Task Tracking (MANDATORY)

**You MUST use TaskCreate / TaskUpdate throughout.** This gives the user real-time visibility. Never skip it.

### Before Stage 0, create the pipeline task list:

```
TaskCreate: "Stage 0: Preflight — branch check, detect stack, plan pipeline"
TaskCreate: "Round 1 · Stage A: Code-review loop"          (skip if --no-review)
TaskCreate: "Round 1 · Stage B: QA cycle (/qa --no-vf)"     (skip if --no-qa)
TaskCreate: "Stage C: Verify + open PR (/vf)"
```

- `TaskUpdate` each task to `in_progress` when you start it, `completed` when done.
- On each new outer round, create `Round {N} · Stage A` / `Round {N} · Stage B` tasks.
- Before finishing, call `TaskList` and ensure every task is in a terminal state (`completed`, or updated with the reason it was skipped). Never stop with orphaned tasks.

---

## Stage 0 — Preflight

**→ TaskUpdate:** Mark "Stage 0: Preflight" `in_progress`. Create the task list above.

1. **Branch guard.** `git rev-parse --abbrev-ref HEAD`. If it's the base branch (`main`/`master` or `--base`), STOP and tell the user to switch to a feature branch. Doing the whole pipeline only to have `/vf` refuse at the end wastes a lot of work.
2. **There must be something to ship.** `git diff --stat origin/<base>...HEAD` (and `git status --porcelain` for uncommitted work). If the branch has no changes vs base and a clean tree, STOP — there's nothing to review, QA, or PR.
3. **Detect stack / port / route** the same way `/qa` and `/vf` do (package.json / pyproject.toml / *.csproj). You don't have to fully start anything here — `/qa` and `/vf` re-detect — but resolve the port/route now so you can pass consistent values through.
4. **Echo the plan** so the user can course-correct before the expensive part:

```
/ship pipeline
  Branch:            feature/settings-page → main
  Feature:           user settings page
  Stages:            A code-review (effort high)  ·  B QA (depth normal)  ·  C /vf → PR
  Convergence:       up to 3 outer rounds, 5 review passes each
  Port / route:      3000 /settings
```

**→ TaskUpdate:** Mark "Stage 0: Preflight" `completed`.

---

## The Outer Loop

Initialize `outer = 1`. Then repeat the following until you converge or hit `--max-outer-iterations`.

### Stage A — Code-Review Loop  (skip if `--no-review`)

**→ TaskUpdate:** Mark "Round {outer} · Stage A: Code-review loop" `in_progress`.

Run `/code-review` against the branch's changes and drive findings to zero. `/code-review` reviews the current diff at a chosen effort and can apply fixes with `--fix`.

**Use the built-in, unscoped `code-review` skill — the one that reviews the working diff and supports `--fix`.** Do NOT use the `code-review:code-review` plugin: it reviews an *existing GitHub PR* (`gh pr …`), has no `--fix`, and there is no PR yet at this stage (the PR is created later in Stage C). Picking the plugin would make this loop unable to ever reach "0 findings".

```
review_pass = 1
review_changed_code = false
loop:
    Invoke:  Skill(skill="code-review", args="<effort> --fix")     # built-in diff reviewer, NOT code-review:code-review
      - <effort> defaults to "high" (or --review-effort). --fix applies the findings to the working tree.
    Read the returned review.
    IF it reports no actionable findings (nothing left to fix):
        → review is CLEAN. Break.
    ELSE:
        → It found (and --fix attempted) issues. Set review_changed_code = true.
        → If any finding could NOT be auto-fixed by --fix (needs judgment, multi-file refactor,
          or a design decision), dispatch a developer Agent to fix it properly, then continue.
        → Commit the fixes. First refuse to stage secrets (same guard as /vf): if `git status --porcelain`
          shows any `.env*`, `*.pem`, or `credentials*` path, STOP and ask the user — never commit those.
          Otherwise:  git add -A && git commit -m "fix: address code review findings (round {outer}, pass {review_pass})"
        → review_pass++. If review_pass > --max-review-iterations (default 5):
            record the remaining findings as UNRESOLVED and break (do not loop forever).
        → Re-run the loop (re-review to confirm the fixes are clean and introduced nothing new).
```

Notes:
- A run that applied fixes is **not** proof of cleanliness — always re-run `/code-review` once more after fixes until a pass comes back with nothing to fix. That final clean pass is what lets `review_changed_code` settle.
- Record `review_changed_code` for the convergence check, and whether any findings were left UNRESOLVED.

**→ TaskUpdate:** Mark the Stage A task `completed`.

### Stage B — QA Cycle  (skip if `--no-qa` or `--skip-browser`)

**→ TaskUpdate:** Mark "Round {outer} · Stage B: QA cycle" `in_progress`.

Invoke the full `/qa` browser cycle. It fans out parallel test agents, auto-fixes bugs with developer agents, runs its own internal code-review gate, and loops internally until clean or its own max-iterations. **Always pass `--no-vf`** so it fixes bugs but does NOT open a PR — Stage C owns the PR.

```
Skill(skill="qa", args="<feature description> --no-vf --port <port> --route <route> --depth <depth> [--a11y] [--responsive] [--perf] [--url <url>] [--start <cmd>]")
```

Pass through only the flags the user actually supplied. When done, read `/qa`'s final report and determine:
- `qa_found_bugs` = did QA find and fix any P0/P1/P2 bugs this round? (Check the report's iteration history / summary, or `.qa/reports/qa-report-iteration-*.md`.)
- `qa_issues_remaining` = did QA hit ITS max-iterations with bugs still unfixed?

If `qa_issues_remaining` is true, record those as UNRESOLVED.

**→ TaskUpdate:** Mark the Stage B task `completed`.

### Convergence Check (end of each outer round)

Decide what to do next:

```
IF (Stage A skipped OR review found nothing this round)  AND  (Stage B skipped OR qa_found_bugs == false):
    → CONVERGED. The branch survived a full pass with nothing left to fix. Exit the outer loop → Stage C.

ELSE IF there are UNRESOLVED findings/bugs AND outer >= --max-outer-iterations:
    → STOP converging. Exit the loop in a NOT-CLEAN state → Stage C will report remaining issues and NOT open a PR.

ELSE IF outer >= --max-outer-iterations:
    → Hit the cap. Exit the loop. If nothing is actually UNRESOLVED, treat as converged; otherwise NOT-CLEAN.

ELSE:
    → Something changed this round (review fixed code and/or QA fixed bugs). The code is different now,
      so it must be re-reviewed and re-tested. Increment outer, create "Round {outer} · Stage A/B" tasks,
      and go back to Stage A.
```

Why re-loop after changes: a code-review fix can break a user flow QA would catch; a QA bug-fix can introduce a code smell or regression the reviewer would catch. Convergence means a round where **neither** stage had anything to change — that's the only honest "all issues fixed" signal.

To keep cost sane: each outer round runs a full `/qa` (which starts a server and fans out agents). The default cap of 3 rounds is usually plenty — most branches converge in 1–2 rounds.

---

## Stage C — Verify + Open PR

**→ TaskUpdate:** Mark "Stage C: Verify + open PR" `in_progress`.

**Branch on the loop's exit state:**

### If the branch did NOT converge clean (UNRESOLVED issues remain after max rounds)

Do **not** open a PR. Print the remaining issues clearly and stop:

```
/ship STOPPED — branch not clean after {outer} rounds
  Unresolved:
    - [review] <finding that --fix + dev agent couldn't safely resolve>
    - [qa BUG-007] P1: <bug /qa couldn't fix in its max-iterations>
  Nothing was pushed. Reports: .qa/reports/ , code-review output above.
```

Run the Task list audit and finish. CI/PR is intentionally skipped — shipping known-broken code is worse than stopping.

### If the branch converged clean

Invoke `/vf` to run local CI and open the single PR. Pass `--qa-passed` **only if Stage B actually ran** (so `/vf` reuses the QA browser evidence and skips its redundant smoke check); otherwise let `/vf` do its own smoke check.

```
# Stage B ran (QA verified in the browser):
Skill(skill="vf", args="<feature description> --qa-passed --port <port> --route <route> [--base <base>] [--no-pr]")

# Stage B was skipped (--no-qa / --skip-browser):
Skill(skill="vf", args="<feature description> --port <port> --route <route> [--base <base>] [--skip-browser] [--no-pr]")
```

`/vf` handles the rest: rebases onto base, runs lint / typecheck / tests / build (its Stage 4 local CI), pushes, and opens the PR with QA evidence in the body. If `/vf` fails at a CI stage, surface which stage failed — do **not** loop back to `/qa` (a failing build/test is a different problem class than a browser bug; report it and let the user decide).

**→ TaskUpdate:** Mark "Stage C: Verify + open PR" `completed`.

---

## Final Summary

Print a compact summary (and run the mandatory TaskList audit — every task in a terminal state):

```
═══════════════════════════════════════════════════
  /ship COMPLETE — <feature>
═══════════════════════════════════════════════════
  Branch:        <branch> → <base>
  Rounds:        {outer} of {max-outer}
  Stage A:       code-review clean after {passes} pass(es)
  Stage B:       QA clean ({qa iterations}, {bugs} bugs found+fixed) | skipped
  Result:        ALL CLEAN → PR opened | STOPPED ({X} issues remaining) | verify-only (--no-pr)
  PR:            <url from /vf, or "not opened — see remaining issues">
  Artifacts:     .qa/reports/  ·  .verify/  ·  code-review output
═══════════════════════════════════════════════════
```

Never invent a PR URL — print only what `/vf` actually returned.

---

## Notes for the model running this command

- **Invoke sub-commands with the `Skill` tool**, e.g. `Skill(skill="code-review", args="high --fix")`, `Skill(skill="qa", args="… --no-vf")`, `Skill(skill="vf", args="… --qa-passed")`. Pass the full arg string as one string.
- **`/qa` is always `--no-vf` here.** That flag (added for orchestrators) makes QA fix bugs and loop but skip its own `/vf`/PR. If you ever see two PRs, you forgot `--no-vf`.
- **The loop is the product.** The single most important behavior is to actually re-review and re-test after anything changes, and to keep going until a clean pass — not to declare victory after the first review or the first QA pass.
- **Bound everything.** Respect `--max-outer-iterations` (rounds) and `--max-review-iterations` (passes inside Stage A) so you can never loop forever. When you hit a cap with issues open, stop and report — don't open a PR.
- **Pass `timeout` on Bash calls** for git/CI operations, mirroring `/vf`'s timeout discipline.
- **Don't reinvent /qa or /vf.** They own server startup, browser testing, CI, rebasing, and PR creation. Your job is sequencing, convergence, and the single final PR decision.
