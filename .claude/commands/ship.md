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
- `--port N`, `--route PATH`, `--start CMD` — server/route hints. Passed through to `/qa` and `/vf` (always include `--start` in the Stage C `/vf` call when one was supplied or detected — `/vf` re-detects otherwise and can pick the wrong command).
- `--url URL` — passed to `/qa` only. **`/vf` has no `--url` flag** — if the user gave only `--url`, derive `--port` and `--route` from that URL and pass those to `/vf` in Stage C.
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
- **Delegate, don't reimplement.** Invoke `/qa` and `/vf` via the `Skill` tool, and `/code-review` via a Sonnet-pinned subagent (see Stage A). Do not hand-roll your own QA or PR logic — these commands already encode it.
- **Code review always runs on Sonnet.** Every `/code-review` pass is dispatched through `Agent(model="sonnet")` — never invoked in the main session, regardless of what model the session runs on. Review is the pipeline's dominant token cost and Sonnet handles it well.
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
2. **There must be something to ship.** If the repo has no `origin` remote, STOP — Stage C must push, so `/ship` can't finish without one. Run `git fetch origin <base>` first so `origin/<base>` exists locally, then `git diff --stat origin/<base>...HEAD` (and `git status --porcelain` for uncommitted work). If the branch has no changes vs base and a clean tree, STOP — there's nothing to review, QA, or PR.
3. **Initialize the pipeline state.** Resolve `SHIP_DIR="$(git rev-parse --absolute-git-dir)/ship"`, `mkdir -p "$SHIP_DIR"`, and write the initial `$SHIP_DIR/state.json` (see "Pipeline State" below). Everywhere this document says `$SHIP_DIR`, it means this one absolute path — substitute the literal path in subagent prompts, they don't inherit shell variables.
4. **Detect stack / port / route** the same way `/qa` and `/vf` do (package.json / pyproject.toml / *.csproj). You don't have to fully start anything here — `/qa` and `/vf` re-detect — but resolve the port/route now so you can pass consistent values through.
5. **Echo the plan** so the user can course-correct before the expensive part:

```
/ship pipeline
  Branch:            feature/settings-page → main
  Feature:           user settings page
  Stages:            A code-review (effort high, sonnet)  ·  B QA (depth normal)  ·  C /vf → PR
  Convergence:       up to 3 outer rounds, 5 review passes each
  Port / route:      3000 /settings
```

**→ TaskUpdate:** Mark "Stage 0: Preflight" `completed`.

---

## Pipeline State (survives context loss)

`$SHIP_DIR/state.json` is the single source of truth for the loop — inside `.git/`, never committed:

```json
{
  "feature": "…", "branch": "…", "base": "main",
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

`report_artifact_url` is set by the Final Summary's report-publish step (null until then).

`rounds[].stageB.iterations`, `.bugs_found`, and `.bugs_fixed` are that round's `iterations`, `bugs_found_total`, and `bugs_fixed_total` from the round's QA `result.json` — copy all three, not just `bugs_found`, since the Final Summary needs the iteration count and fixed count too. Update the file at EVERY stage boundary (Stage A done, Stage B done, convergence decision, Stage C). The convergence check and Stage C read this file, not conversation memory. **If the conversation gets summarized mid-run, re-read `$SHIP_DIR/state.json` and resume from `status` + `outer` — never re-derive loop state from prose.**

`unresolved` holds tagged objects, never bare strings — `"source": "review"` for a Stage A finding that survived `--fix` + a dev agent (with a `detail` string), `"source": "qa"` for a QA `remaining` entry (copied through with its `id`/`severity`/`summary` intact). Stage A and Stage B each **append** their own round's entries — a stage never overwrites what the other stage already wrote this round. At the top of each new round, clear entries from the *previous* round before either stage runs (a fresh round re-earns its own unresolved list; stale entries from a round that's being re-attempted must not linger).

---

## The Outer Loop

Initialize `outer = 1`. Then repeat the following until you converge or hit `--max-outer-iterations`.

### Stage A — Code-Review Loop  (skip if `--no-review`)

**→ TaskUpdate:** Mark "Round {outer} · Stage A: Code-review loop" `in_progress`.

Run `/code-review` against the branch's changes and drive findings to zero. `/code-review` reviews the current diff at a chosen effort and can apply fixes with `--fix`.

**Code review ALWAYS runs on Sonnet — never in the main session.** Review is the pipeline's biggest token sink, and the main session may be on a far more expensive model (Fable/Opus). Dispatch every review pass through a subagent pinned to `model: "sonnet"`. No exceptions: not for "just one quick pass", not because the session model is already cheap, not on re-review passes.

**Use the built-in, unscoped `code-review` skill — the one that reviews the working diff and supports `--fix`.** Do NOT use the `code-review:code-review` plugin: it reviews an *existing GitHub PR* (`gh pr …`), has no `--fix`, and there is no PR yet at this stage (the PR is created later in Stage C). Picking the plugin would make this loop unable to ever reach "0 findings".

```
review_pass = 1
REVIEW_TARGET = last_clean_review_sha from state.json, else <base>
    # The first review of the run covers the full branch diff vs <base>. Once a pass has
    # come back clean, everything up to that SHA is reviewed code — later reviews (later
    # rounds) only cover the diff SINCE that SHA. Never re-review the whole branch after
    # a recorded clean pass. REVIEW_TARGET stays FIXED within this Stage A loop.
loop:
    EFFORT = --review-effort (default high) if review_pass == 1,
             else --review-effort IF the user explicitly passed it, else "medium"
    # Pass 1 already covered this span at full effort; later passes confirm fresh fixes
    # and catch regressions — medium is enough for that BY DEFAULT. But an explicit
    # --review-effort is a user override and must hold for every pass, not just the first —
    # silently downgrading an explicit `max` (or upgrading an explicit `low`) on
    # later passes would ignore what the user asked for.
    Dispatch the review to a Sonnet subagent (NEVER invoke code-review directly in the main session):
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
      - --fix applies the findings to the working tree.
    Read the subagent's returned verdict (full details are on disk if you need them).
    IF it reports no actionable findings (nothing left to fix):
        → review is CLEAN. Record last_clean_review_sha = `git rev-parse HEAD` in state.json. Break.
    ELSE:
        → It found (and --fix attempted) issues.
        → If any finding could NOT be auto-fixed by --fix (needs judgment, multi-file refactor,
          or a design decision), dispatch a developer Agent to fix it properly — point it at the
          review file for full context — then continue.
        → Commit the fixes. First refuse to stage secrets (same guard as /vf): if `git status --porcelain`
          shows any `.env*`, `*.pem`, or `credentials*` path, STOP and ask the user — never commit those.
          Otherwise:  git add -A && git commit -m "fix: address code review findings (round {outer}, pass {review_pass})"
        → review_pass++. If review_pass > --max-review-iterations (default 5):
            record the remaining findings as UNRESOLVED and break (do not loop forever).
        → Re-run the loop (re-review to confirm the fixes are clean and introduced nothing new).
```

Notes:
- A run that applied fixes is **not** proof of cleanliness — always re-run `/code-review` once more after fixes until a pass comes back with nothing to fix.
- Record whether Stage A **ended clean** or left findings **UNRESOLVED** in `$SHIP_DIR/state.json` (`rounds[].stageA`, plus `last_clean_review_sha`) — that is what the convergence check keys on. If UNRESOLVED, append each surviving finding to `unresolved` as `{ "source": "review", "detail": "file:line — why it needs judgment" }` (append, don't overwrite — Stage B appends its own entries later this round). Review fixes made this round do NOT by themselves force another round: Stage B tests them in this very round.

**→ TaskUpdate:** Mark the Stage A task `completed`.

### Stage B — QA Cycle  (skip if `--no-qa` or `--skip-browser`)

**→ TaskUpdate:** Mark "Round {outer} · Stage B: QA cycle" `in_progress`.

Invoke the full `/qa` browser cycle. It fans out parallel test agents, auto-fixes bugs with developer agents, runs its own internal code-review gate, and loops internally until clean or its own max-iterations. **Always pass `--no-vf`** so it fixes bugs but does NOT open a PR — Stage C owns the PR.

```
Skill(skill="qa", args="<feature description> --no-vf --run-id ship-round-{outer} --port <port> --route <route> --depth <depth> [--a11y] [--responsive] [--perf] [--url <url>] [--start <cmd>]")
```

Pass through only the flags the user actually supplied — except `--run-id ship-round-{outer}`, which you ALWAYS pass so each round's QA evidence gets its own directory (`$(git rev-parse --absolute-git-dir)/qa/ship-round-{outer}/`) instead of clobbering the previous round's. When done, read `$(git rev-parse --absolute-git-dir)/qa/ship-round-{outer}/result.json` — `/qa` maintains it as its machine-readable outcome — and derive:
- `qa_found_bugs` = `bugs_found_total > 0`
- `qa_issues_remaining` = `status == "issues-remaining"` (the `remaining` array lists them)
- `artifact_url` — the QA report artifact, for the final summary and PR body.

Do NOT parse the markdown reports for these — `result.json` is the contract. Fall back to `reports/qa-report-iteration-*.md` + `artifact-url.txt` only if `result.json` is missing (older `/qa`). If `qa_issues_remaining` is true, append each `remaining` entry into `$SHIP_DIR/state.json`'s `unresolved` array as `{ "source": "qa", ...entry }` — append, do NOT overwrite the array (Stage A may have already appended its own `source: "review"` entries this round). Record Stage B's outcome in `state.json` (`rounds[].stageB` — including `iterations`, `bugs_found`, `bugs_fixed`) either way.

**→ TaskUpdate:** Mark the Stage B task `completed`.

### Convergence Check (end of each outer round)

Decide what to do next:

```
IF (Stage A skipped OR Stage A ended clean with nothing UNRESOLVED)  AND  (Stage B skipped OR qa_found_bugs == false):
    → CONVERGED. Exit the outer loop → Stage C.
    NOTE: Stage A fixing issues does NOT block convergence — a clean Stage A ends on a clean
    re-review pass, and this round's QA already tested those fixes. Only QA changing code
    forces another round, because QA's fixes land AFTER the last clean review.

ELSE IF Stage A left findings UNRESOLVED AND (Stage B skipped OR qa_found_bugs == false):
    → Those findings already survived --max-review-iterations passes WITH dev-agent help,
      and either QA never ran or QA changed no code since — an identical round would just
      repeat the same failure. Exit NOT-CLEAN → Stage C reports the remaining findings and
      does NOT open a PR.

ELSE IF there are UNRESOLVED findings/bugs AND outer >= --max-outer-iterations:
    → STOP converging. Exit the loop in a NOT-CLEAN state → Stage C will report remaining issues and NOT open a PR.

ELSE IF outer >= --max-outer-iterations:
    → Hit the cap. Exit the loop. If nothing is actually UNRESOLVED, treat as converged; otherwise NOT-CLEAN.

ELSE:
    → QA fixed bugs this round (qa_found_bugs == true), so code changed after the last clean
      review and must be re-reviewed (and the review's own fixes re-tested). Increment outer,
      CLEAR `unresolved` in state.json to `[]` (this round's findings, if any, will re-populate
      it fresh — see "Pipeline State" above), create "Round {outer} · Stage A/B" tasks, and go
      back to Stage A.
```

Write the decision to `$SHIP_DIR/state.json` (`outer`, `status`, this round's outcomes) BEFORE moving on — the next stage reads loop state from the file, not from conversation memory.

Why this converges correctly: within a round, Stage A runs first and ends clean, then Stage B tests exactly that reviewed code. So a round where QA found nothing means the current code is both review-clean AND QA-clean — done, even if Stage A fixed things earlier in the round. Re-looping on review fixes alone would re-run a full `/qa` (server + agent fan-out) on code QA just passed — pure waste. The one asymmetry: QA's bug-fixes come after the review, so they alone trigger the next round.

To keep cost sane: the default cap of 3 rounds is usually plenty — with this convergence rule most branches converge in exactly 1 round.

---

## Stage C — Verify + Open PR

**→ TaskUpdate:** Mark "Stage C: Verify + open PR" `in_progress`.

**Branch on the loop's exit state:**

### If the branch did NOT converge clean (UNRESOLVED issues remain after max rounds)

Do **not** open a PR. Read `unresolved` from `$SHIP_DIR/state.json` (the authoritative list), print it clearly — render each `source: "review"` entry as `[review] <detail>` and each `source: "qa"` entry as `[qa <id>] <severity>: <summary>` — and stop:

```
/ship STOPPED — branch not clean after {outer} rounds
  Unresolved:
    - [review] <finding that --fix + dev agent couldn't safely resolve>
    - [qa BUG-007] P1: <bug /qa couldn't fix in its max-iterations>
  Nothing was pushed. Reports: QA artifact URL(s) printed by /qa (local copies under
  $(git rev-parse --absolute-git-dir)/qa/ship-round-*/reports/), full code reviews under
  $(git rev-parse --absolute-git-dir)/ship/.
```

Run the Task list audit and finish. CI/PR is intentionally skipped — shipping known-broken code is worse than stopping.

### If the branch converged clean

Invoke `/vf` to run local CI and open the single PR. Pass `--qa-passed` **only if Stage B actually ran** (so `/vf` reuses the QA browser evidence and skips its redundant smoke check); otherwise let `/vf` do its own smoke check.

```
# Stage B ran (QA verified in the browser):
Skill(skill="vf", args="<feature description> --qa-passed --port <port> --route <route> [--start <cmd>] [--base <base>] [--no-pr]")

# Stage B was skipped (--no-qa / --skip-browser):
Skill(skill="vf", args="<feature description> --port <port> --route <route> [--start <cmd>] [--base <base>] [--skip-browser] [--no-pr]")
```

`/vf` handles the rest: rebases onto base, runs lint / typecheck / tests / build (its Stage 4 local CI), pushes, and opens the PR with QA evidence in the body. If `/vf` fails at a CI stage, surface which stage failed — do **not** loop back to `/qa` (a failing build/test is a different problem class than a browser bug; report it and let the user decide).

**→ TaskUpdate:** Mark "Stage C: Verify + open PR" `completed`.

---

## Final Summary

### Publish the pipeline report artifact (before printing the summary)

Every run ends with a published report — converged, STOPPED, and verify-only alike (a STOPPED run needs it most):

1. Build `$SHIP_DIR/report.html` — one self-contained page assembled from `state.json` and the on-disk round records:
   - Run header: feature, branch → base, final result, rounds used.
   - Per-round table: Stage A passes with findings found / fixed / unresolved, Stage B iterations + bugs found/fixed (or the skip reason).
   - Per-pass review summaries distilled from `$SHIP_DIR/review-round-*-pass-*.md` (finding titles + severity + fixed-or-not — not the full text).
   - Stage C outcome: CI stage results, the PR URL, or the stop reason with the `unresolved` list.
   - Links to each round's QA report artifact and the `/vf` verification artifact.
   No embedded screenshots — link the QA/verify artifacts instead. If you do embed an image, splice the base64 in with a script — never through the Write/Edit tools.
2. Load the `artifact-design` skill first if it's available, then publish: `Artifact(file_path="<literal $SHIP_DIR>/report.html", favicon="🚢", description="/ship pipeline report for <feature>")`. Give the page a stable `<title>` naming the feature. Re-publishing the same file path redeploys to the same URL.
3. Save the returned URL to `$SHIP_DIR/artifact-url.txt`, record it as `report_artifact_url` in `state.json`, and print it in the summary's `Report:` line.

### Print the summary

Print a compact summary (and run the mandatory TaskList audit — every task in a terminal state):

```
═══════════════════════════════════════════════════
  /ship COMPLETE — <feature>
═══════════════════════════════════════════════════
  Branch:        <branch> → <base>
  Rounds:        {outer} of {max-outer}
  Stage A:       code-review clean after {passes} pass(es)
  Stage B:       QA clean ({qa iterations}, {bugs} bugs found+fixed) | skipped
                 (source: rounds[].stageB.iterations / .bugs_found / .bugs_fixed in state.json)
  Result:        ALL CLEAN → PR opened | STOPPED ({X} issues remaining) | verify-only (--no-pr)
  PR:            <url from /vf, or "not opened — see remaining issues">
  Report:        <pipeline report artifact URL>
  Artifacts:     QA report artifact <url per round>  ·  verification artifact <url from /vf>  ·  code reviews
                 (local working copies live under $(git rev-parse --absolute-git-dir)/qa/, /ship/ (state.json +
                 review files), and /verify/ — never committed)
═══════════════════════════════════════════════════
```

Never invent a PR URL — print only what `/vf` actually returned.

---

## Notes for the model running this command

- **Invoke `/qa` and `/vf` with the `Skill` tool**, e.g. `Skill(skill="qa", args="… --no-vf")`, `Skill(skill="vf", args="… --qa-passed")`. Pass the full arg string as one string. `/code-review` is the exception: it always goes through a `general-purpose` Agent with `model: "sonnet"` (Stage A shows the exact call) so review tokens are spent on Sonnet, not the session model.
- **`/qa` is always `--no-vf` here.** That flag (added for orchestrators) makes QA fix bugs and loop but skip its own `/vf`/PR. If you ever see two PRs, you forgot `--no-vf`.
- **The loop is the product.** The single most important behavior is to actually re-review and re-test after anything changes, and to keep going until a clean pass — not to declare victory after the first review or the first QA pass.
- **Bound everything.** Respect `--max-outer-iterations` (rounds) and `--max-review-iterations` (passes inside Stage A) so you can never loop forever. When you hit a cap with issues open, stop and report — don't open a PR.
- **Pass `timeout` on Bash calls** for git/CI operations, mirroring `/vf`'s timeout discipline.
- **Don't reinvent /qa or /vf.** They own server startup, browser testing, CI, rebasing, and PR creation. Your job is sequencing, convergence, and the single final PR decision.
