---
description: Run a bounded browser QA, parallel subagent, auto-fix, review, and retest loop
argument-hint: "[feature] [--url URL] [--port N] [--route PATH] [--start CMD] [--no-start] [--depth shallow|normal|deep] [--a11y] [--responsive] [--perf] [--no-fix] [--no-vf] [--run-id ID] [--max-iterations N]"
---

# Pi QA convergence workflow

Run a complete QA cycle for `$ARGUMENTS`:

`RECON → PARALLEL TEST → REPORT → FIX IN WORKTREES → REVIEW → RETEST`, repeating until clean or bounded by `--max-iterations` (default 3).

Use the `subagent` tool. Browser work must use `browser-qa`; implementation uses `worker`; review uses `reviewer`. Never stop after applying fixes without retesting.

## Arguments and defaults

Parse feature text and flags: `--url`, `--port`, `--route`, `--start`, `--no-start`, `--depth` (default normal), `--a11y`, `--responsive`, `--perf`, `--no-fix`, `--no-vf`, `--run-id`, `--max-iterations` (default 3).

Infer stack/start command/port from project instructions and project files. Ask once only when a required value cannot be inferred. `--url` and `--no-start` skip server startup.

## Non-negotiable rules

- Keep all state, reports, logs, screenshots, worktree metadata, and HTML under the absolute git directory, never the tracked tree.
- Use unique Playwright CLI sessions for every parallel test agent.
- Every P0/P1/P2 failure needs steps, expected/actual behavior, and screenshot or console/network evidence. P3 is observational and does not drive the fix loop.
- Parallel fix agents must not touch overlapping files. Cluster first.
- Never stage secret-like paths (`.env*`, `*.pem`, `credentials*`).
- Persist state after every phase; recover from the state file after compaction.
- Emit a short phase/iteration status line before each expensive operation.

## Phase 0 — initialize and start

Resolve:

```bash
GIT_DIR="$(git rev-parse --absolute-git-dir 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/pi")"
QA_BASE="$GIT_DIR/pi-qa"
RUN_ID="<--run-id or run-YYYYmmdd-HHMMSS>"
QA_DIR="$QA_BASE/$RUN_ID"
mkdir -p "$QA_DIR"/{reports,fixes,worktrees} "$QA_DIR/screenshots/iteration-1"
printf '%s' "$RUN_ID" > "$QA_BASE/latest-run"
```

Create `$QA_DIR/state.json` containing feature, URL, stack, start command, port, depth, iteration=1, max_iterations, status=`in-progress`, server ownership/PID, cumulative bug registry, and phase outcomes. This file is authoritative.

If needed, start the app with `nohup <start> >"$QA_DIR/server.log" 2>&1 &`, record PID, and poll the target for up to 90 seconds. Do not kill an app supplied through `--url` or `--no-start`. On startup failure, save logs, set status=`stopped`, and stop.

## Phase 1 — reconnaissance

Dispatch one `browser-qa` subagent with a unique session such as `qa-${RUN_ID}-recon-${iteration}`. Give it the literal target URL and QA_DIR. It must:

- open the URL with `playwright-cli -s=<session>`;
- snapshot and inventory every interactive element, form, state, and navigation path;
- inspect `console error` and `requests`;
- save baseline screenshot under `screenshots/iteration-N/00-initial-state.png`;
- write `$QA_DIR/page-inventory.md`;
- close the session and return at most 10 summary lines.

Require a non-empty inventory. Resolve auth walls, blank pages, or server blockers before continuing.

## Phase 2 — parallel browser tests

Build test tasks from depth:

- always: happy path and form/input validation;
- normal/deep: error states and edge cases;
- deep or flag: accessibility, responsive, performance.

Dispatch all applicable `browser-qa` tasks in one `subagent` parallel call (maximum four concurrently; batches are fine). Give each task:

- a unique session `qa-${RUN_ID}-${category}-${iteration}`;
- the literal URL, inventory path, screenshot directory, iteration, category mandate, and output paths;
- instructions to snapshot before interactions, use returned element refs, screenshot each scenario, inspect console/network failures, close its session, and write both `$QA_DIR/findings-${category}-${iteration}.json` and `.md`.

JSON tests contain `scenario`, `steps`, `result`, `severity`, `expected`, `actual`, `screenshot`, `console_errors`, and `fix_hint`. Treat a crashed agent as a reported test gap, not a clean result.

Consolidate outputs, preserving stable BUG IDs across iterations. New failures receive the next BUG number; matching old failures retain their ID. Classify prior bugs as FIXED, STILL OPEN, or REGRESSION.

## Phase 3 — report and state

Write:

- `$QA_DIR/reports/qa-report-iteration-N.md` with category counts, prioritized findings, evidence links, passed tests, and iteration delta;
- `$QA_DIR/reports/report.html`, a self-contained local report covering all iterations. If embedding screenshots, use a script to base64 files; never stream image base64 through model write/edit calls;
- `$QA_DIR/result.json`:

```json
{
  "status": "in-progress | clean | issues-remaining",
  "iterations": 1,
  "bugs_found_total": 0,
  "bugs_fixed_total": 0,
  "remaining": [],
  "report_path": "/absolute/path/report.html"
}
```

Count only unique P0/P1/P2 bugs. Ensure `bugs_found_total - bugs_fixed_total == remaining.length`.

Decision:
- zero failures → finalize clean;
- `--no-fix` or iteration limit reached → finalize issues-remaining;
- otherwise continue immediately to fixes.

## Phase 4 — isolated parallel fixes

Before creating worktrees, ensure the tested source is committed. Inspect status, refuse secret-like paths, and create a descriptive checkpoint commit for task-related pending changes when necessary.

Cluster open bugs by likely source files. For each non-overlapping cluster:

1. Create branch `pi/qa-${RUN_ID}-c<index>` and a temporary worktree outside the repository, recording branch/path in state.
2. Dispatch `worker` tasks in one parallel subagent call, each with its worktree as `cwd`.
3. Require root-cause fixes, targeted checks, a summary under `$QA_DIR/fixes/`, and a commit. No pushes.

Merge each successful branch with `git merge --no-edit`. If a merge conflicts, abort it; never auto-resolve. Re-run that cluster sequentially with `worker` in the main tree, then commit. Remove worktrees and delete merged temporary branches after recording their commits.

## Phase 5 — review gate

Record the pre-fix SHA before merging. Dispatch `reviewer` against that SHA through current HEAD and any uncommitted changes. Save its output to `$QA_DIR/reports/code-review-iteration-N.md`.

If blockers exist, dispatch `worker` with the exact findings, then dispatch `reviewer` again. Bound this inner review loop to 3 passes. Unresolved blockers are remaining issues and prevent a clean result.

## Phase 6 — retest loop

Increment iteration, update state, and create the next screenshot directory. Prefer hot reload. Restart only if the server died, dependencies/config changed, or the stack lacks hot reload. Install changed dependencies before a dependency-triggered restart. Use cache deletion only as a stale-behavior fallback and request destructive-command approval when prompted.

Return to Phase 1. Continue until clean or max iterations. Never ask whether to continue.

## Finalize

Always close this run's Playwright sessions and stop only the server process this workflow started, preferring graceful termination before force. Finalize `result.json`, state, Markdown, and HTML. Print iteration history, remaining issues, report path, and working directory.

If clean and `--no-vf` was not supplied, read `~/.pi/agent/prompts/vf.md` and execute that workflow in the current session with the original feature plus `--qa-passed --qa-run-id "$RUN_ID"`, preserving detected port, route, and start command. If issues remain, do not run `/vf`.
