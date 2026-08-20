---
description: Run a bounded browser QA, parallel subagent, auto-fix, review, and retest loop
argument-hint: "[feature] [--url URL] [--port N] [--route PATH] [--start CMD] [--no-start] [--depth shallow|normal|deep] [--a11y] [--responsive] [--perf] [--no-fix] [--no-vf] [--run-id ID] [--max-iterations N] [--worktree PATH] [--no-worktree]"
---

# Pi QA convergence workflow

Run a complete QA cycle for `$ARGUMENTS`:

`RECON → PARALLEL TEST → REPORT → FIX IN WORKTREES → REVIEW → RETEST`, repeating until clean or bounded by `--max-iterations` (default 3).

Use the `subagent` tool. Browser work must use `browser-qa`; implementation uses `worker`; review uses `reviewer`. Never stop after applying fixes without retesting.

## Arguments and defaults

Parse feature text and flags: `--url`, `--port`, `--route`, `--start`, `--no-start`, `--depth` (default normal), `--a11y`, `--responsive`, `--perf`, `--no-fix`, `--no-vf`, `--run-id`, `--max-iterations` (default 3), `--worktree PATH`, and `--no-worktree`.

Before Phase 0, read the `worktree-first` skill completely and resolve `WORK_CWD`. QA requires an existing linked feature worktree by default because creating a new worktree from the origin default branch would lose the feature under test. From the primary checkout, stop unless the user selects a registered path with `--worktree PATH` or explicitly uses `--no-worktree`; never stash, copy, or auto-commit pending work. Use `WORK_CWD` for project discovery, Git operations, servers, tests, browser agents, and all fix/review agents; never silently fall back to the primary checkout. Persist its absolute path, branch, and opt-out status in QA state.

Infer stack/start command/port from project instructions and project files under `WORK_CWD`. Ask once only when a required value cannot be inferred. `--url` and `--no-start` skip server startup.

If `--run-id` is supplied, validate it before using it in any path, session name, worktree, or branch: it must be 1–64 characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase letters, digits, and single hyphens only). Reject the run before Phase 0 for any other value; never sanitize or partially use an invalid ID. The generated default must be a valid unique slug such as `run-YYYYmmdd-HHMMSS-$$` (the PID suffix avoids same-second collisions). An explicitly supplied ID is never resumed: an existing run directory is an error.

## Non-negotiable rules

- Keep all state, reports, logs, screenshots, worktree metadata, and HTML under the absolute git directory, never the tracked tree.
- Use unique Playwright CLI sessions for every parallel test agent.
- Every P0/P1/P2 failure needs steps, expected/actual behavior, and screenshot or console/network evidence. P3 is observational and does not drive the fix loop.
- Parallel fix agents must not touch overlapping files. Cluster first.
- Never stage secret-like paths (`.env*`, `*.pem`, `credentials*`).
- Persist state after every phase; recover from the state file after compaction.
- Emit a short phase/iteration status line before each expensive operation.
- Preserve the feature worktree after QA and report its path; remove only temporary cluster worktrees after safe merges.

## Phase 0 — initialize and start

Resolve:

```bash
GIT_COMMON_DIR="$(git -C "$WORK_CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/pi")"
QA_BASE="$GIT_COMMON_DIR/pi-qa"
RUN_ID="<--run-id or run-YYYYmmdd-HHMMSS-$$>"
if [ "${#RUN_ID}" -gt 64 ] || [[ ! "$RUN_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    printf '%s\n' 'Invalid --run-id: use 1–64 lowercase slug characters separated by single hyphens.' >&2
    exit 2
fi
mkdir -p "$QA_BASE"
QA_DIR="$QA_BASE/$RUN_ID"
# mkdir (without -p) is the atomic run claim. Never resume or merge state from
# an old run, even if it looks stopped; callers must choose a new ID.
if ! mkdir "$QA_DIR"; then
    printf 'Refusing existing QA run ID: %s at %s. Inspect its owner/PIDs before removing a stale run.\n' "$RUN_ID" "$QA_DIR" >&2
    exit 2
fi
printf '%s\n' "pid=$$" > "$QA_DIR/owner"
qa_cleanup_notice() { printf 'QA run %s stopped; inspect %s and owned PIDs before cleanup.\n' "$RUN_ID" "$QA_DIR" >&2; }
trap qa_cleanup_notice EXIT
mkdir -p "$QA_DIR"/{reports,fixes,worktrees} "$QA_DIR/screenshots/iteration-1"
# Refuse orphaned state from a deleted run directory too. Worktree creation in
# Phase 4 repeats these checks immediately before each branch is created.
QA_BRANCH_PREFIX="pi/qa-$RUN_ID-"
if git for-each-ref --format='%(refname:short)' refs/heads/ | grep -q "^$QA_BRANCH_PREFIX"; then
    printf 'Refusing QA run: branch prefix already exists: %s\n' "$QA_BRANCH_PREFIX" >&2
    exit 2
fi
```

Create `$QA_DIR/state.json` containing the exact `run_id`, absolute `qa_dir`, exact `work_cwd`, worktree branch and opt-out status, result/report paths, feature, URL, stack, start command, port, depth, iteration=1, max_iterations, status=`in-progress`, server ownership/PID, cumulative bug registry, and phase outcomes. This file is authoritative. If any Phase 0 claim or preflight check fails, do not create state or reuse any worktree, branch, session, or report from that ID. There is no shared latest-run pointer; callers must pass this exact ID.

If needed, before starting the app inspect the target port with an OS-appropriate listener check (`lsof`/`ss`/`netstat`) and refuse an occupied or unverifiable port. Never kill or adopt another service. Start only with `nohup <start> >"$QA_DIR/server.log" 2>&1 &`, record the owned PID and process-tree path under this run, and poll the target for up to 90 seconds only while that root PID and required process tree remain alive. Health alone is insufficient and an exited/changed owner is a startup failure. Do not kill an app supplied through `--url` or `--no-start`. On startup failure, save logs, set status=`stopped`, and stop.

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

Use these concrete mandates verbatim when building category tasks. Every task must use only this run's exact session name and paths; a crashed or unexpectedly closed session is a test gap, not evidence of a pass:

- **Happy path:** complete the primary user flow from its initial state through its success state; verify the visible result, persisted/navigation state, and the key interaction after reload when applicable.
- **Validation:** submit empty, malformed, boundary, and corrected values; verify every invalid input gets a specific visible message, focus remains usable, no invalid mutation occurs, and valid correction succeeds.
- **Error/edge:** exercise loading, empty, delayed, failed, duplicate, unauthorized, unavailable, and back/refresh states that the feature can encounter; verify safe recovery and no uncaught console or failed-request regressions.
- **Accessibility:** use keyboard-only navigation; verify logical focus order, visible focus, accessible names/labels, keyboard operability, semantic landmarks/headings, and no obvious contrast or focus-trap defect at each relevant state.
- **Responsive:** test at 320px, 768px, and 1440px (or the nearest supported widths); verify content remains usable, no unintended horizontal overflow or clipping occurs, and navigation/forms remain operable.
- **Performance:** capture navigation/interaction timing and request evidence on the primary flow; identify slow or repeated requests, blocking work, layout jank, and console warnings, and report measurements rather than declaring a pass without evidence.

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

Before creating worktrees, ensure the tested source is committed in `WORK_CWD`. Inspect status, refuse secret-like paths, and create a descriptive checkpoint commit for task-related pending changes when necessary. Record `FEATURE_HEAD=$(git -C "$WORK_CWD" rev-parse HEAD)`. Resolve the current origin default branch by querying `git -C "$WORK_CWD" ls-remote --symref origin HEAD`, fetch that exact ref, and record its commit; never use local `HEAD` or local origin/HEAD as a creation base.

Cluster open bugs by likely source files. For each non-overlapping cluster:

1. Immediately before each cluster, refuse if branch `pi/qa-${RUN_ID}-c<index>` already exists (`git -C "$WORK_CWD" show-ref --verify --quiet`) or if the target worktree path already exists. Create the branch and temporary worktree outside the repository from the freshly fetched `origin/$DEFAULT_BRANCH` in one `git -C "$WORK_CWD" worktree add -b ... "$path" "origin/$DEFAULT_BRANCH"` operation. Then merge the recorded `FEATURE_HEAD` into that temporary branch before dispatch so fixes see the tested feature. If creation or this preparatory merge fails or conflicts, abort the merge and stop; never retry from another base or auto-resolve. Record branch/path/base/preparation commit in state before dispatch.
2. Dispatch `worker` tasks in one parallel subagent call, each with its claimed worktree as `cwd`.
3. Require root-cause fixes, targeted checks, a summary under `$QA_DIR/fixes/`, and a commit. No pushes.

Merge each successful branch into the feature branch from `WORK_CWD` with `git merge --no-edit`. If a merge conflicts, abort it; never auto-resolve. Re-run that cluster sequentially with `worker` in `WORK_CWD`, then commit. Remove only the temporary cluster worktrees and delete their merged temporary branches after recording their commits; preserve `WORK_CWD`.

## Phase 5 — review gate

Record the pre-fix SHA before merging. Dispatch `reviewer` against that SHA through current HEAD and any uncommitted changes. Save its output to `$QA_DIR/reports/code-review-iteration-N.md`.

If blockers exist, dispatch `worker` with the exact findings, then dispatch `reviewer` again. Bound this inner review loop to 3 passes. Unresolved blockers are remaining issues and prevent a clean result.

## Phase 6 — retest loop

Increment iteration, update state, and create the next screenshot directory. Prefer hot reload. Restart only if the server died, dependencies/config changed, or the stack lacks hot reload. Before every restart, repeat the occupied-port refusal and owned PID/process-tree-plus-health checks; never kill or adopt a listener from another run. Install changed dependencies before a dependency-triggered restart. Use cache deletion only as a stale-behavior fallback and request destructive-command approval when prompted.

Return to Phase 1. Continue until clean or max iterations. Never ask whether to continue.

## Finalize

Always close this run's Playwright sessions and stop only the server process this workflow started, preferring graceful termination before force. Finalize `result.json`, state, Markdown, and HTML. Print iteration history, remaining issues, report path, and the preserved `WORK_CWD` path/branch.

If clean and `--no-vf` was not supplied, resolve `PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"`, read `"$PI_CODING_AGENT_DIR/prompts/vf.md"`, and execute that workflow in the current session with the original feature plus `--qa-passed --qa-run-id "$RUN_ID"` and `--worktree "$WORK_CWD"` when isolated (or the explicit `--no-worktree` opt-out), preserving detected port, route, and start command. If issues remain, do not run `/vf`.
