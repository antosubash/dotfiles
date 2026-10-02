---
description: Take a feature branch all the way to a merge-ready PR. Requires a clean git tree and checkpoints it so the whole run can be rolled back. Runs /optimize once to shrink and dedupe the feature code, then a full-convergence pipeline — loops /code-review until it reports zero findings, runs the full /qa browser cycle (which fixes bugs), then re-reviews whatever changed, repeating until a complete pass finds no review issues AND no QA bugs, and finally runs /vf to open exactly one PR. Use this whenever you want to "ship", "finalize", "wrap up", "finish", or "get this branch ready for review/merge" — i.e. do the full review + QA + verify + PR dance in one shot, not just a single review or a single QA pass.
argument-hint: [feature description] [--port N] [--route PATH] [--url URL] [--start CMD] [--base BRANCH] [--depth shallow|normal|deep] [--review-effort low|medium|high|max] [--max-outer-iterations N] [--max-review-iterations N] [--no-optimize] [--optimize-aggressive] [--no-review] [--no-qa] [--no-pr] [--skip-browser] [--a11y] [--responsive] [--perf]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, TaskCreate, TaskUpdate, TaskList, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_hover, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_fill_form, mcp__plugin_playwright_playwright__browser_select_option, mcp__plugin_playwright_playwright__browser_press_key, mcp__plugin_playwright_playwright__browser_wait_for, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_network_request, mcp__plugin_playwright_playwright__browser_evaluate, mcp__plugin_playwright_playwright__browser_tabs, mcp__plugin_playwright_playwright__browser_navigate_back, mcp__plugin_playwright_playwright__browser_close, mcp__plugin_playwright_playwright__browser_resize, mcp__plugin_playwright_playwright__browser_file_upload, mcp__plugin_playwright_playwright__browser_handle_dialog
---

# /ship — Review → QA → Verify → PR (full-convergence pipeline)

You are a release lead taking a feature branch to a clean, merge-ready PR. You sequence existing commands and loop until the branch is genuinely clean:

```
STAGE 0  preflight: clean tree + checkpoint refs/ship/start
STAGE O  /optimize --safe-only   (once, before the loop, so review+QA verify the optimized code)
OUTER LOOP (until a full pass is clean, or max-outer hit):
  STAGE A  code-review loop: /code-review → fix → re-review until 0 findings (or max-review)
  STAGE B  /qa --no-vf: full browser test + auto-fix, loops internally
  CONVERGENCE CHECK
STAGE C  /vf [--qa-passed] → local CI + exactly ONE PR
```

Review and QA both change code, and changed code can break — so re-review and re-test after changes, and open the PR only once a complete pass finds nothing left to fix. (Design rationale: `~/.claude/workflow-refs/ship/convergence-rationale.md` — Read it only if a convergence decision is ambiguous.)

## Arguments

User invoked with: `$ARGUMENTS`

- **Feature description** — free text (anything not a flag). Passed to `/qa` and `/vf`; used in the PR body.
- `--port N`, `--route PATH`, `--start CMD` — passed to `/qa` and `/vf`. Always include `--start` in the Stage C `/vf` call when supplied or detected (`/vf` re-detects otherwise and can pick the wrong command).
- `--url URL` — `/qa` only. `/vf` has no `--url`: if only `--url` was given, derive `--port`/`--route` from it for `/vf`.
- `--base BRANCH` — base for rebase + PR (default `main`, else `master`). Passed to `/vf`.
- `--depth shallow|normal|deep` — QA thoroughness (default `normal`). Passed to `/qa`.
- `--review-effort low|medium|high|max` — `/code-review` effort (default `high`).
- `--max-outer-iterations N` — max review↔QA rounds (default **3**; each runs a full `/qa`).
- `--max-review-iterations N` — max passes inside one Stage A loop (default **5**).
- `--no-optimize` — skip Stage O. `--optimize-aggressive` — Stage O uses `--aggressive` instead of `--safe-only`.
- `--no-review` — skip Stage A (QA still runs its own internal review gate).
- `--no-qa` — skip Stage B; `/vf` then runs without `--qa-passed` and does its own smoke check.
- `--no-pr` — full pipeline, but pass `--no-pr` to `/vf` (verify only).
- `--skip-browser` — non-web project: implies `--no-qa`, and passes `--skip-browser` to `/vf`.
- `--a11y`, `--responsive`, `--perf` — passed to `/qa`.

Don't ask clarifying questions when reasonable defaults exist — echo what you detected and proceed. Ask **once** only for a value you genuinely cannot infer (e.g. a port with no detectable default).

## Hard Rules

- **This is a real loop.** Keep going until an exit condition: a fully clean pass, or `max-outer-iterations`. Never stop after one round to ask whether to continue, and never declare victory after the first review or QA pass.
- **Exactly one PR.** `/qa` is ALWAYS invoked with `--no-vf` (it fixes bugs and loops but skips its own `/vf`/PR — two PRs means you forgot it). Only Stage C opens a PR, only if converged clean and no `--no-pr`.
- **Never open a PR with known unfixed issues.** Capped with issues open → stop and report, no `/vf`.
- **Clean tree in, rollback point recorded.** Start only from a clean tree; record `refs/ship/start`. Every pipeline change after that is a commit, so `git reset --hard refs/ship/start` restores the branch. Never stash, discard, or auto-commit the user's work without asking. Never stage `.env*`, `*.pem`, `credentials*`.
- **Feature branch only.** Refuse on the base branch up front (`/vf` would reject it at the end anyway).
- **Delegate, don't reimplement.** Invoke `/optimize`, `/qa`, `/vf` via the `Skill` tool, passing the full arg string as one string. They own server startup, browser testing, CI, rebasing and PR creation; your job is sequencing, convergence, and the single PR decision.
- **Code review ALWAYS runs in a Sonnet subagent** — `Agent(subagent_type="general-purpose", model="sonnet")`, never in the main session, no exceptions (not for a quick pass, not on re-review, not if the session model is cheap). Review is the dominant token cost. It must use the **built-in, unscoped `code-review` skill** (reviews the working diff, supports `--fix`) — NEVER the `code-review:code-review` plugin, which reviews an existing GitHub PR, has no `--fix`, and there is no PR yet, so the loop could never reach 0 findings.
- **Decide from sub-command output.** After each invocation, read what it returned / wrote to decide whether findings or bugs remain.
- **Bound everything** by the two iteration caps. **Pass `timeout` on Bash calls** for git/CI operations.

## Task Tracking (MANDATORY)

Before Stage 0, TaskCreate:
```
"Stage 0: Preflight — branch check, detect stack, plan pipeline"
"Stage O: Optimize (/optimize --safe-only)"            (skip if --no-optimize)
"Round 1 · Stage A: Code-review loop"                  (skip if --no-review)
"Round 1 · Stage B: QA cycle (/qa --no-vf)"            (skip if --no-qa)
"Stage C: Verify + open PR (/vf)"
```
TaskUpdate each to `in_progress` when you start it and `completed` when done. Each new outer round creates `Round {N} · Stage A` / `Round {N} · Stage B` tasks. Before finishing, `TaskList` and ensure every task is terminal (`completed`, or updated with its skip reason) — no orphans.

## Pipeline State (survives context loss)

`SHIP_DIR="$(git rev-parse --absolute-git-dir)/ship"` — inside `.git/`, never committed. Substitute the literal absolute path in subagent prompts (they don't inherit shell variables). `$SHIP_DIR/state.json` is the single source of truth for the loop:

```json
{
  "feature": "…", "branch": "…", "base": "main",
  "start_sha": "…",
  "optimize": { "result": "applied | nothing-to-do | skipped | failed", "lines_removed": 0, "commits": 0, "checkpoint_sha": "…" },
  "outer": 1, "max_outer": 3,
  "last_clean_review_sha": null,
  "rounds": [
    { "round": 1,
      "stageA": { "passes": 2, "result": "clean | unresolved | skipped" },
      "stageB": { "result": "clean | bugs-fixed | unresolved | skipped",
                  "iterations": 0, "bugs_found": 0, "bugs_fixed": 0, "artifact_url": "…" } }
  ],
  "unresolved": [
    { "source": "review", "detail": "file:line — why it needs judgment" },
    { "source": "qa", "id": "BUG-007", "severity": "P1", "summary": "one line" }
  ],
  "report_artifact_url": null,
  "status": "in-progress | converged | stopped"
}
```

- Update it at EVERY stage boundary (Stage O, Stage A, Stage B, convergence decision, Stage C). The convergence check and Stage C read the file, not conversation memory. **If the conversation is summarized mid-run, re-read `state.json` and resume from `status` + `outer` — never re-derive loop state from prose.**
- `unresolved` holds tagged objects, never bare strings. Stage A and Stage B each **append** their own entries — never overwrite what the other stage wrote this round. It is cleared to `[]` at the start of each new round (see Convergence Check).
- `report_artifact_url` stays null until the Final Summary publishes the report.

## Stage 0 — Preflight

1. **Branch guard.** `git rev-parse --abbrev-ref HEAD`; if it's the base (`main`/`master`/`--base`), STOP and tell the user to switch to a feature branch.
2. **Clean tree.** Refuse if a merge/rebase/cherry-pick is in progress. If `git status --porcelain` (untracked included) is non-empty, list the files and ask **once**: commit them as `wip: snapshot before /ship` (refuse if any `.env*`/`*.pem`/`credentials*` would be staged — the user handles those), or abort. Never stash/discard. Don't continue until clean.
3. **Something to ship.** No `origin` remote → STOP (Stage C must push). `git fetch origin <base>`, then `git diff --stat origin/<base>...HEAD`; no changes vs base → STOP.
4. **Checkpoint.** `git update-ref refs/ship/start HEAD`; record the SHA as `start_sha`.
5. **Init state.** `mkdir -p "$SHIP_DIR"` and write the initial `state.json`.
6. **Detect stack / port / route** as `/qa` and `/vf` do (package.json / pyproject.toml / *.csproj) — no need to start anything; resolve port/route now so you pass consistent values through.
7. **Echo the plan** so the user can course-correct before the expensive part:
```
/ship pipeline
  Branch:            feature/settings-page → main
  Feature:           user settings page
  Checkpoint:        a1b2c3d  (rollback: git reset --hard refs/ship/start)
  Stages:            O optimize (safe-only)  ·  A code-review (effort high, sonnet)  ·  B QA (depth normal)  ·  C /vf → PR
  Convergence:       up to 3 outer rounds, 5 review passes each
  Port / route:      3000 /settings
```

## Stage O — Optimize (skip if `--no-optimize`; runs once, never in later rounds)

```
Skill(skill="optimize", args="--base <base> --safe-only")     # default
Skill(skill="optimize", args="--base <base> --aggressive")    # --optimize-aggressive
```
The flag keeps it non-interactive. `/optimize` checks the clean tree itself, sets `refs/optimize/checkpoint`, verifies each batch and commits each passing batch — so `refs/ship/start` stays a valid rollback point. When it returns:
1. `git status --porcelain` must be empty. If not, `git reset --hard HEAD` (only its own uncommitted edits — Stage 0 proved the tree clean) and record `failed`.
2. Record `optimize` in `state.json`: result, net lines removed (`git diff --shortstat refs/optimize/checkpoint HEAD`), count of `refactor(optimize)` commits, checkpoint SHA.
3. If it stopped on a broken baseline build, don't fix it here — record `failed` and continue (review/QA will surface it; Stage C's CI gate blocks the PR if it persists).

## Outer Loop (`outer = 1`)

### Stage A — Code-Review Loop (skip if `--no-review`)

```
review_pass = 1
REVIEW_TARGET = last_clean_review_sha from state.json, else <base>
    # First review covers the full branch diff; after a recorded clean pass, later rounds
    # review only the diff SINCE that SHA — never the whole branch again.
    # REVIEW_TARGET stays FIXED within this Stage A loop.
loop:
    EFFORT = --review-effort (default high) if review_pass == 1,
             else --review-effort IF the user explicitly passed it, else "medium"
    Agent(subagent_type="general-purpose", model="sonnet", prompt="
      Invoke the built-in code-review skill via the Skill tool:
      Skill(skill=\"code-review\", args=\"{EFFORT} {REVIEW_TARGET} --fix\")
      {REVIEW_TARGET} is the review target — a base branch or a commit SHA. ALWAYS pass it
      so the review covers the diff from that point to HEAD, never just uncommitted
      working-tree changes (a clean tree with no target could silently review nothing).
      This is the unscoped built-in diff reviewer — NOT the code-review:code-review plugin.
      If the Skill tool or the code-review skill is unavailable in your context, do the
      review yourself instead: read `git diff {REVIEW_TARGET}...HEAD` plus uncommitted
      changes and review for correctness bugs, then apply safe fixes — do not just give up.
      Write the COMPLETE review — every finding with file:line, severity, description,
      whether --fix resolved it and if not why — to
      {literal $SHIP_DIR}/review-round-{outer}-pass-{review_pass}.md.
      Return ONLY a verdict: 'CLEAN — 0 findings', or 'N findings, F fixed, U unfixed'
      plus one line per UNFIXED finding (file:line — why it needs judgment). Nothing
      else — the full review lives in the file, not in your reply.")
    Read the verdict (full details are in the review file if needed).
    IF it reports nothing left to fix:
        → CLEAN. Record last_clean_review_sha = `git rev-parse HEAD`. Break.
    ELSE:
        → For findings --fix couldn't resolve (judgment, multi-file refactor, design decision),
          dispatch a developer Agent pointed at the review file to fix them properly.
        → Commit: if `git status --porcelain` shows any `.env*`/`*.pem`/`credentials*` path,
          STOP and ask the user. Otherwise:
          git add -A && git commit -m "fix: address code review findings (round {outer}, pass {review_pass})"
        → review_pass++. If review_pass > --max-review-iterations: mark UNRESOLVED, break.
        → Loop: a pass that applied fixes is not proof of cleanliness — re-review until a pass
          comes back with nothing to fix.
```

Record `rounds[].stageA` (passes, `clean`/`unresolved`) and `last_clean_review_sha` in `state.json`. If UNRESOLVED, append each surviving finding to `unresolved` as `{ "source": "review", "detail": "file:line — why it needs judgment" }`.

### Stage B — QA Cycle (skip if `--no-qa` or `--skip-browser`)

`/qa` fans out test agents, auto-fixes bugs, runs its own review gate and loops internally.
```
Skill(skill="qa", args="<feature description> --no-vf --run-id ship-round-{outer} --port <port> --route <route> --depth <depth> [--a11y] [--responsive] [--perf] [--url <url>] [--start <cmd>]")
```
Pass through only flags the user supplied — except `--no-vf` and `--run-id ship-round-{outer}`, which are ALWAYS passed (the run id gives each round its own evidence dir instead of clobbering the previous one). Then read `$(git rev-parse --absolute-git-dir)/qa/ship-round-{outer}/result.json` — the machine-readable contract; don't parse markdown reports (fall back to `reports/qa-report-iteration-*.md` + `artifact-url.txt` only if `result.json` is missing, i.e. older `/qa`):
- `qa_found_bugs` = `bugs_found_total > 0`
- `qa_issues_remaining` = `status == "issues-remaining"` (listed in `remaining`)
- `artifact_url` — the QA report artifact, for the summary and PR body.

Record `rounds[].stageB`: result, `artifact_url`, and `iterations` / `bugs_found` / `bugs_fixed` copied from `iterations` / `bugs_found_total` / `bugs_fixed_total` (all three — the summary needs them). If `qa_issues_remaining`, append each `remaining` entry to `unresolved` as `{ "source": "qa", ...entry }` (keeping `id`/`severity`/`summary`).

### Convergence Check (end of each round)

```
IF (Stage A skipped OR ended clean with nothing UNRESOLVED) AND (Stage B skipped OR qa_found_bugs == false):
    → CONVERGED → Stage C. (Stage A having fixed things does NOT block this: its last pass was
      clean and this round's QA tested those fixes. Only QA changing code forces another round.)
ELSE IF Stage A left findings UNRESOLVED AND (Stage B skipped OR qa_found_bugs == false):
    → Exit NOT-CLEAN (an identical round would repeat the same failure).
ELSE IF anything is UNRESOLVED AND outer >= --max-outer-iterations:
    → Exit NOT-CLEAN.
ELSE IF outer >= --max-outer-iterations:
    → Exit; converged if nothing is actually UNRESOLVED, else NOT-CLEAN.
ELSE:
    → QA fixed bugs after the last clean review: outer++, clear `unresolved` to [] (stale entries
      must not linger), create "Round {outer} · Stage A/B" tasks, go back to Stage A.
```
Write the decision (`outer`, `status`, round outcomes) to `state.json` BEFORE moving on.

## Stage C — Verify + Open PR

**NOT-CLEAN:** do NOT open a PR or run `/vf` — shipping known-broken code is worse than stopping. Read `~/.claude/workflow-refs/ship/finish.md` and print its STOPPED message from `state.json`'s `unresolved`. Then continue to the Final Summary (it publishes the report — a STOPPED run needs it most — and does the task audit).

**Converged clean:** run `/vf` for local CI + the single PR. Pass `--qa-passed` **only if Stage B actually ran** (reuses QA browser evidence, skips its smoke check):
```
# Stage B ran:
Skill(skill="vf", args="<feature description> --qa-passed --port <port> --route <route> [--start <cmd>] [--base <base>] [--no-pr]")
# Stage B skipped (--no-qa / --skip-browser):
Skill(skill="vf", args="<feature description> --port <port> --route <route> [--start <cmd>] [--base <base>] [--skip-browser] [--no-pr]")
```
`/vf` rebases, runs lint/typecheck/tests/build, pushes and opens the PR with QA evidence. If it fails at a CI stage, report which stage — do **not** loop back to `/qa`; let the user decide.

## Final Summary (every run: converged, STOPPED, verify-only)

Read `~/.claude/workflow-refs/ship/finish.md`, then:
1. Build `$SHIP_DIR/report.html` per its spec and publish it as an Artifact; save the URL to `$SHIP_DIR/artifact-url.txt` and `report_artifact_url` in `state.json`.
2. Print the summary using its template (Stage B numbers from `rounds[].stageB` in `state.json`).
3. Run the TaskList audit — every task terminal.

Never invent a PR URL — print only what `/vf` actually returned.
