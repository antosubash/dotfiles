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
- Persist all decisions; recover from state after compaction.

Fetch `origin/<base>`. Inspect branch diff and working tree. Refuse secret-like paths and create a repository-consistent checkpoint commit for intended pending feature changes so review/worktree agents see the tested source.

Resolve:

```bash
SHIP_DIR="$(git rev-parse --absolute-git-dir)/pi-ship"
mkdir -p "$SHIP_DIR"
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

Read `~/.pi/agent/prompts/qa.md` completely and execute that workflow in this current session with:

- original feature and browser flags;
- `--run-id ship-round-<outer>`;
- `--no-vf`;
- the chosen depth and max QA iterations.

Do not spawn a child Pi to run the whole QA workflow: destructive approvals and long-running browser state belong in the interactive parent session. Subagents are used by the QA workflow itself.

Read `$(git rev-parse --absolute-git-dir)/pi-qa/ship-round-<outer>/result.json`. Trust it over prose. Record iterations, bugs found/fixed, remaining issues, and report path. Append remaining QA items to `unresolved` with source=`qa`.

### Convergence decision

At the end of each round:

- Stage A clean/skipped AND QA clean with `bugs_found_total == 0` (or QA skipped) → converged.
- Stage A unresolved and QA made no changes → stop not-clean; an identical round would not help.
- unresolved issues at max outer bound → stop not-clean.
- QA found and fixed bugs, with no remaining issues → clear stale prior-round unresolved entries, increment outer, and return to Stage A because QA changed code after the clean review.
- QA has remaining issues → continue only when under the bound and another round can plausibly change the result; otherwise stop not-clean.

Write the decision before proceeding. Never ask whether to continue.

## Final stage

If not clean, do not push or open a PR. Print tagged unresolved review/QA items and continue to the final local report.

If converged, read `~/.pi/agent/prompts/vf.md` completely and execute that workflow in this current session. Pass original feature/base/start/port/route flags, `--qa-passed --qa-run-id ship-round-<outer>` when QA ran, `--skip-browser` when it did not, and `--no-pr` when requested. `/vf` runs local CI, pushes, and creates the single PR.

Do not loop back to QA for a local-CI failure; report the failed gate.

## Final report

Build `$SHIP_DIR/report.html` from state and on-disk review/QA/verify records: run result, per-round review passes, QA iterations/counts, unresolved items, CI status, report paths, and PR URL. Keep it local and self-contained; use a script for any image encoding.

Print a compact summary with branch/base, rounds, review passes, QA counts, final result, PR URL or reason not opened, report paths, and working directories. Never invent a PR URL.
