---
description: Converge review and browser QA, then verify and open exactly one merge-ready PR
argument-hint: "[feature] [--port N] [--route PATH] [--url URL] [--start CMD] [--base BRANCH] [--depth shallow|normal|deep] [--review-effort low|medium|high|max] [--max-outer-iterations N] [--max-review-iterations N] [--no-review] [--no-qa] [--no-pr] [--skip-browser] [--a11y] [--responsive] [--perf] [--worktree PATH] [--no-worktree]"
---

# Pi ship convergence workflow

Take `$ARGUMENTS` from feature branch to a merge-ready PR:

`REVIEW → FIX → RE-REVIEW → QA → QA FIX/RETEST → repeat if QA changed code → VERIFY → ONE PR`.

The loop is the product. Continue automatically until clean or a bound is reached. Never open a PR with known unresolved issues.

## Parse and preflight

Parse feature text and flags, including `--worktree PATH` and `--no-worktree`. Defaults: resolve base by querying the remote itself with `git -C "$WORK_CWD" ls-remote --symref origin HEAD` and accepting its single `refs/heads/<base>` target; never trust local `origin/HEAD` or guess main/master. Depth normal; review effort high; max outer rounds 3; max review passes 3.

Read the `worktree-first` skill completely and resolve `WORK_CWD` before any checkpoint, rebase, review, test, or run-state creation. Shipping normally requires an existing linked worktree because it must preserve the current feature branch; when invoked from the primary checkout without an explicit opt-out, stop with safe migration instructions rather than creating a derived shipping branch. Use `WORK_CWD` as `cwd` for every agent and all project/Git operations.

Hard rules:

- Refuse on the base branch, without origin, or when there is nothing to ship.
- Never force-push, auto-resolve conflicts, stage secrets, or create more than one PR.
- `/qa` always runs with `--no-vf`; only the final `/vf` owns push/PR.
- Review fixes are not clean until a focused confirmation pass resolves every blocking finding.
- Only P0/P1 findings block shipping. Record P2/P3 suggestions in the report without spending another fix/review pass.
- The first review establishes the full-branch baseline. Later passes review only the fix delta and verify the existing finding ledger; they may add a new blocker only when the fix itself introduced a concrete P0/P1 regression.
- QA fixes happen after review and therefore force one focused outer review of the QA delta.
- When `--url URL` is supplied, parse it with a URL parser before invoking `/vf`: derive `--port` from its explicit port or the scheme default (`http` 80, `https` 443), and derive `--route` as its pathname plus query string (use `/` when the pathname is empty). Pass those derived values explicitly because `/vf` has no `--url` input; reject conflicting explicit `--port`/`--route` values rather than silently testing a different target.
- Persist all decisions; recover from state after compaction.
- Never silently fall back from `WORK_CWD` to the primary checkout. Preserve and report the feature worktree after shipping.

From `WORK_CWD`, fetch `origin/<base>`. Inspect branch diff and working tree. Refuse secret-like paths and create a repository-consistent checkpoint commit for intended pending feature changes so review/worktree agents see the tested source.

Resolve a collision-resistant run ID and claim its directory atomically:

```bash
GIT_COMMON_DIR="$(git -C "$WORK_CWD" rev-parse --path-format=absolute --git-common-dir)"
SHIP_BASE="$GIT_COMMON_DIR/pi-ship"
BRANCH="$(git -C "$WORK_CWD" branch --show-current)"
BRANCH_SLUG="$(printf '%s' "$BRANCH" | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | sed 's/--*/-/g; s/^-//; s/-$//' | cut -c1-24 | sed 's/-$//')"
BRANCH_SLUG="${BRANCH_SLUG:-branch}"
SHIP_RUN_ID="ship-${BRANCH_SLUG}-$(date +%Y%m%d-%H%M%S)-$$"
SHIP_DIR="$SHIP_BASE/$SHIP_RUN_ID"
mkdir -p "$SHIP_BASE"
if ! mkdir "$SHIP_DIR"; then
    printf 'Refusing ship run: unable to atomically claim %s. Choose a new run ID; if this is stale, inspect it before removing it.\n' "$SHIP_DIR" >&2
    exit 2
fi
printf '%s\n' "pid=$$" > "$SHIP_DIR/owner"
ship_cleanup_notice() {
    printf 'Ship run %s stopped; inspect %s before cleanup.\n' "$SHIP_RUN_ID" "$SHIP_DIR" >&2
}
trap ship_cleanup_notice EXIT
```

The claimed `$SHIP_DIR` is immutable run identity under the common Git directory, so it survives feature-worktree cleanup: keep state, every review/QA/verify record, and the final report inside it. Create `$SHIP_DIR/state.json` with `run_id`=`$SHIP_RUN_ID`, exact `ship_dir`, exact `work_cwd`, feature, branch, base, outer=1, bounds, last_clean_review_sha, per-round review/QA results, unresolved tagged findings, status=`in-progress`, report path, and eventual PR URL. Maintain `$SHIP_DIR/review-ledger.json` with stable finding IDs, severity, location, first-seen pass, status (`open`, `fixed`, `verified`, `advisory`), and evidence. Update both files at every boundary. Print the detected pipeline before expensive work. Never reuse a directory from another run; if a run is abandoned, inspect its `owner` and processes before removing it.

## Deterministic pre-review gate

Before spending a reviewer turn, run the repository's cheap deterministic checks once from `WORK_CWD`: project instructions, secret-path guard, `git -C "$WORK_CWD" diff --check`, changed-file syntax/format checks, broken-symlink detection, and the narrowest relevant existing tests. Fix deterministic failures directly and commit them before review. Do not ask a reviewer to rediscover shell syntax, malformed JSON, broken links, or already-covered test failures.

Detect whether browser QA is relevant from the changed files and project shape. When the change is configuration, documentation, shell tooling, agent prompts, or other non-web code with no runnable route—and the user did not explicitly supply `--url`, `--port`, or `--route`—set Stage B to `skipped-non-web` automatically. Do not start a browser merely because `/ship` supports QA.

## Outer loop

### Stage A — scoped, severity-gated review loop

Skip only for `--no-review`.

Set the stage target to `last_clean_review_sha` when present, otherwise `origin/<base>`. Keep it fixed for the stage. Use stable IDs (`R1`, `R2`, ...) in `review-ledger.json`; never renumber or silently reopen a verified item.

**Initial baseline review (only when no prior clean review exists):** dispatch `reviewer` once with `cwd=WORK_CWD` against `<stage-target>...HEAD` plus uncommitted changes, project instructions, surrounding code, and tests. Ask for concrete findings only, each with severity and evidence. Save the complete output. Add P0/P1 findings to the ledger as `open`; add P2/P3 as `advisory`. If there are no open blockers, Stage A is clean even when advisories exist.

**Later outer rounds:** code before `last_clean_review_sha` is already reviewed. Dispatch `reviewer-fast` with `cwd=WORK_CWD` against only `last_clean_review_sha...HEAD` and the ledger entries affected by that delta. This is a comprehensive review of the new QA/fix delta, not a new audit of unchanged branch history.

For each open-blocker fix pass, up to the default maximum of 3 total review passes:

1. Record `FIX_BASE=$(git -C "$WORK_CWD" rev-parse HEAD)` and dispatch `worker` with `cwd=WORK_CWD` and only the exact open P0/P1 ledger entries. Run targeted checks, guard secrets, and commit the fixes from `WORK_CWD`.
2. Dispatch `reviewer-fast` with `cwd=WORK_CWD` against `FIX_BASE...HEAD` plus the open ledger entries. Its mandate is to verify each blocker and inspect the fix delta for concrete P0/P1 regressions. It must not broaden into unchanged code or promote new P2 hardening ideas into blockers.
3. Mark confirmed items `verified`; add a new item only for a P0/P1 regression caused by this fix delta. Record P2/P3 observations as `advisory` without another loop.
4. When no blockers remain, record `git -C "$WORK_CWD" rev-parse HEAD` as `last_clean_review_sha`, mark Stage A clean, and stop reviewing.
5. If blockers remain after the pass bound, record them under `unresolved` and stop not-clean. Do not exceed the bound by asking a differently worded full review.

Use a specialist agent only when an open P0/P1 finding genuinely requires domain expertise. `worker` owns edits. A clean focused confirmation plus the original full baseline is sufficient evidence; do not re-review the entire branch.

### Stage B — QA loop

Skip for `--no-qa`, `--skip-browser`, or the pre-review `skipped-non-web` decision.

Resolve `PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"` and read `"$PI_CODING_AGENT_DIR/prompts/qa.md"` completely. Before starting QA, claim a collision-resistant run ID and store it in ship state:

```bash
SHIP_QA_RUN_ID="ship-${BRANCH_SLUG}-qa-${outer}-$(date +%Y%m%d-%H%M%S)-$$"
```

It is a valid QA slug and includes the branch, round, timestamp, and process ID, so concurrent ships cannot share a round-only state directory. Execute that workflow in this current session with:

- original feature and browser flags;
- `--worktree "$WORK_CWD"` when isolated, or the explicit `--no-worktree` opt-out;
- `--run-id "$SHIP_QA_RUN_ID"`;
- `--no-vf`;
- the chosen depth and max QA iterations.

Read the claimed run's `result.json` using the exact `$SHIP_QA_RUN_ID`; never fall back to `latest-run` or another ship's QA directory.

Do not spawn a child Pi to run the whole QA workflow: destructive approvals and long-running browser state belong in the interactive parent session. Subagents are used by the QA workflow itself.

Read `$GIT_COMMON_DIR/pi-qa/$SHIP_QA_RUN_ID/result.json` and copy the exact absolute QA directory, run ID, result path, and report path into `$SHIP_DIR/state.json`. Trust that file over prose. Record the exact QA run ID, iterations, bugs found/fixed, remaining issues, and report path. Append remaining QA items to `unresolved` with source=`qa`.

### Convergence decision

At the end of each round, make the following decision in this order and write it to state before proceeding:

1. If QA has remaining issues, continue only when `outer < max_outer_iterations` and another round can plausibly change the result; otherwise set `status=not-clean`, stop, and do not run `/vf`.
2. If Stage A is unresolved and QA made no changes, set `status=not-clean`, stop, and do not run `/vf`; repeating an identical round cannot help.
3. If Stage A is clean/skipped and QA is clean/skipped with `bugs_found_total == 0`, set `status=converged`. A clean QA result with zero bugs is terminal because the clean review still covers the current source.
4. If QA is clean and `bugs_found_total > 0 && bugs_fixed_total > 0`, QA changed code after the clean review. Clear stale prior-round unresolved QA entries and require one more Stage A review, even though this QA run is clean. If review was disabled with `--no-review`, the required final review cannot be performed: set `status=not-clean` and stop without a PR. Otherwise, if `outer < max_outer_iterations`, increment `outer` and return to Stage A. If the outer bound is exhausted, set `status=not-clean` with reason `QA fixes require a final review but max outer iterations was reached`; stop without pushing or opening a PR.
5. Any other non-converged state is `status=not-clean`; stop at the bound rather than opening a PR.

A clean QA run with no bugs may converge; a clean QA run that found and fixed bugs may never directly converge without the additional review. Never ask whether to continue.

## Final stage

If not clean, do not push or open a PR. Print tagged unresolved review/QA items and continue to the final local report.

If converged, resolve `PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"`, read `"$PI_CODING_AGENT_DIR/prompts/vf.md"` completely, and execute that workflow in this current session. Generate a new valid `SHIP_VF_RUN_ID="vf-${BRANCH_SLUG}-$(date +%Y%m%d-%H%M%S)-$$"` for this verify invocation and pass it as `--run-id "$SHIP_VF_RUN_ID"` plus `--worktree "$WORK_CWD"` when isolated (or the explicit `--no-worktree` opt-out), along with original feature/base/start flags and explicit `--port`/`--route` (using the values derived from `--url` above when supplied), plus `--qa-passed --qa-run-id "$SHIP_QA_RUN_ID"` when QA ran, `--skip-browser` when it did not, and `--no-pr` when requested. Copy the exact VF run ID, `VF_DIR`, state path, report path, and PR URL into `$SHIP_DIR/state.json`; never substitute a latest-run path. `/vf` runs local CI, pushes, and creates the single PR.

Do not loop back to QA for a local-CI failure; report the failed gate.

## Final report

Build `$SHIP_DIR/report.html` from state and the exact on-disk review/QA/verify records: run ID and directory, run result, per-round review passes, QA iterations/counts, unresolved items, CI status, exact state/report paths, and PR URL. Keep it local and self-contained; use a script for any image encoding.

Print a compact summary with branch/base, rounds, review passes, QA counts, final result, PR URL or reason not opened, report paths, and the preserved `WORK_CWD` path/branch. Never invent a PR URL.
