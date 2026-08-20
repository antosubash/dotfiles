---
description: Converge review and browser QA, then verify and open exactly one merge-ready PR
argument-hint: "[feature] [--port N] [--route PATH] [--url URL] [--start CMD] [--base BRANCH] [--depth shallow|normal|deep] [--review-effort low|medium|high|max] [--max-outer-iterations N] [--max-review-iterations N] [--no-review] [--no-qa] [--no-pr] [--skip-browser] [--a11y] [--responsive] [--perf]"
---

# Pi ship convergence workflow

Take `$ARGUMENTS` from feature branch to a merge-ready PR:

`REVIEW → FIX → RE-REVIEW → QA → QA FIX/RETEST → repeat if QA changed code → VERIFY → ONE PR`.

The loop is the product. Continue automatically until clean or a bound is reached. Never open a PR with known unresolved issues.

## Parse and preflight

Parse feature text and flags. Defaults: base from origin HEAD then main/master; depth normal; review effort high; max outer rounds 3; max review passes 5.

Hard rules:

- Refuse on the base branch, without origin, or when there is nothing to ship.
- Never force-push, auto-resolve conflicts, stage secrets, or create more than one PR.
- `/qa` always runs with `--no-vf`; only the final `/vf` owns push/PR.
- Review fixes are not clean until another reviewer pass returns `VERDICT: CLEAN`.
- QA fixes happen after review and therefore force another outer review round.
- When `--url URL` is supplied, parse it with a URL parser before invoking `/vf`: derive `--port` from its explicit port or the scheme default (`http` 80, `https` 443), and derive `--route` as its pathname plus query string (use `/` when the pathname is empty). Pass those derived values explicitly because `/vf` has no `--url` input; reject conflicting explicit `--port`/`--route` values rather than silently testing a different target.
- Persist all decisions; recover from state after compaction.

Fetch `origin/<base>`. Inspect branch diff and working tree. Refuse secret-like paths and create a repository-consistent checkpoint commit for intended pending feature changes so review/worktree agents see the tested source.

Resolve:

```bash
SHIP_DIR="$(git rev-parse --absolute-git-dir)/pi-ship"
BRANCH="$(git branch --show-current)"
mkdir -p "$SHIP_DIR"
BRANCH_SLUG="$(printf '%s' "$BRANCH" | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | sed 's/--*/-/g; s/^-//; s/-$//' | cut -c1-24 | sed 's/-$//')"
BRANCH_SLUG="${BRANCH_SLUG:-branch}"
```

Create `$SHIP_DIR/state.json` with feature, branch, base, outer=1, bounds, last_clean_review_sha, per-round review/QA results, unresolved tagged findings, status=`in-progress`, report path, and eventual PR URL. Update it at every boundary. Print the detected pipeline before expensive work.

## Outer loop

### Stage A — bounded review/fix loop

Skip only for `--no-review`.

Set review target to `last_clean_review_sha` when present, otherwise `origin/<base>`. Keep that target fixed within the stage.

For each pass:

1. Dispatch `reviewer` against `<target>...HEAD` plus uncommitted changes, project instructions, surrounding code, and tests. Save complete output to `$SHIP_DIR/review-round-<outer>-pass-<pass>.md`.
2. If `VERDICT: CLEAN`, record current HEAD as `last_clean_review_sha`, mark Stage A clean, and break.
3. Otherwise dispatch `worker` with the exact findings to fix actionable issues. Run targeted checks. Refuse secret paths, commit fixes as `fix: address review findings (round X, pass Y)`, and review again.
4. If max passes is reached, record every surviving finding under `unresolved` with source=`review`; Stage A is unresolved.

Use the specialist agent appropriate to the finding as an additional read-only consultation when useful, but `worker` owns edits.

### Stage B — QA loop

Skip for `--no-qa` or `--skip-browser`.

Resolve `PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"` and read `"$PI_CODING_AGENT_DIR/prompts/qa.md"` completely. Before starting QA, claim a collision-resistant run ID and store it in ship state:

```bash
SHIP_QA_RUN_ID="ship-${BRANCH_SLUG}-${outer}-$(date +%Y%m%d-%H%M%S)-$$"
```

It is a valid QA slug and includes the branch, round, timestamp, and process ID, so concurrent ships cannot share a round-only state directory. Execute that workflow in this current session with:

- original feature and browser flags;
- `--run-id "$SHIP_QA_RUN_ID"`;
- `--no-vf`;
- the chosen depth and max QA iterations.

Read the claimed run's `result.json` using the exact `$SHIP_QA_RUN_ID`; never fall back to `latest-run` or another ship's QA directory.

Do not spawn a child Pi to run the whole QA workflow: destructive approvals and long-running browser state belong in the interactive parent session. Subagents are used by the QA workflow itself.

Read `$(git rev-parse --absolute-git-dir)/pi-qa/$SHIP_QA_RUN_ID/result.json`. Trust it over prose. Record the exact QA run ID, iterations, bugs found/fixed, remaining issues, and report path. Append remaining QA items to `unresolved` with source=`qa`.

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

If converged, resolve `PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"`, read `"$PI_CODING_AGENT_DIR/prompts/vf.md"` completely, and execute that workflow in this current session. Pass original feature/base/start flags and explicit `--port`/`--route` (using the values derived from `--url` above when supplied), plus `--qa-passed --qa-run-id "$SHIP_QA_RUN_ID"` when QA ran, `--skip-browser` when it did not, and `--no-pr` when requested. `/vf` runs local CI, pushes, and creates the single PR.

Do not loop back to QA for a local-CI failure; report the failed gate.

## Final report

Build `$SHIP_DIR/report.html` from state and on-disk review/QA/verify records: run result, per-round review passes, QA iterations/counts, unresolved items, CI status, report paths, and PR URL. Keep it local and self-contained; use a script for any image encoding.

Print a compact summary with branch/base, rounds, review passes, QA counts, final result, PR URL or reason not opened, report paths, and working directories. Never invent a PR URL.
