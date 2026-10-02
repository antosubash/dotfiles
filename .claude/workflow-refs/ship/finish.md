# /ship — finish templates (report artifact, STOPPED message, final summary)

Read by `/ship` at Stage C (NOT-CLEAN branch) and at the Final Summary. `$SHIP_DIR` = `$(git rev-parse --absolute-git-dir)/ship`.

## STOPPED message (Stage C, branch did not converge clean)

Render each `unresolved` entry from `state.json`: `source: "review"` → `[review] <detail>`; `source: "qa"` → `[qa <id>] <severity>: <summary>`.

```
/ship STOPPED — branch not clean after {outer} rounds
  Unresolved:
    - [review] <finding that --fix + dev agent couldn't safely resolve>
    - [qa BUG-007] P1: <bug /qa couldn't fix in its max-iterations>
  Nothing was pushed. Roll back the whole run: git reset --hard refs/ship/start
  Reports: QA artifact URL(s) printed by /qa (local copies under
  $(git rev-parse --absolute-git-dir)/qa/ship-round-*/reports/), full code reviews under
  $(git rev-parse --absolute-git-dir)/ship/.
```

## Pipeline report artifact (every run: converged, STOPPED, verify-only)

1. Build `$SHIP_DIR/report.html` — one self-contained page assembled from `state.json` and the on-disk round records:
   - Run header: feature, branch → base, final result, rounds used, `start_sha` + rollback command.
   - Stage O: lines removed, commits, or the skip/failure reason.
   - Per-round table: Stage A passes with findings found / fixed / unresolved; Stage B iterations + bugs found/fixed (or the skip reason).
   - Per-pass review summaries distilled from `$SHIP_DIR/review-round-*-pass-*.md` (finding titles + severity + fixed-or-not — not the full text).
   - Stage C outcome: CI stage results, the PR URL, or the stop reason with the `unresolved` list.
   - Links to each round's QA report artifact and the `/vf` verification artifact.
   No embedded screenshots — link the QA/verify artifacts. If you do embed an image, splice the base64 in with a script, never through Write/Edit.
2. Load the `artifact-design` skill first if available, then publish: `Artifact(file_path="<literal $SHIP_DIR>/report.html", icon="ship", description="/ship pipeline report for <feature>")`. Give the page a stable `<title>` naming the feature. Re-publishing the same path redeploys to the same URL.
3. Save the returned URL to `$SHIP_DIR/artifact-url.txt`, set `report_artifact_url` in `state.json`, and print it in the summary's `Report:` line.

## Final summary template

```
═══════════════════════════════════════════════════
  /ship COMPLETE — <feature>
═══════════════════════════════════════════════════
  Branch:        <branch> → <base>
  Rounds:        {outer} of {max-outer}
  Stage O:       optimize -{lines} lines in {commits} commit(s) | nothing to do | skipped | failed
  Stage A:       code-review clean after {passes} pass(es)
  Stage B:       QA clean ({qa iterations}, {bugs} bugs found+fixed) | skipped
                 (source: rounds[].stageB.iterations / .bugs_found / .bugs_fixed in state.json)
  Result:        ALL CLEAN → PR opened | STOPPED ({X} issues remaining) | verify-only (--no-pr)
  PR:            <url from /vf, or "not opened — see remaining issues">
  Report:        <pipeline report artifact URL>
  Rollback:      git reset --hard refs/ship/start   (<start_sha>; before a PR is pushed — after that, use git revert)
  Artifacts:     QA report artifact <url per round>  ·  verification artifact <url from /vf>  ·  code reviews
                 (local working copies live under $(git rev-parse --absolute-git-dir)/qa/, /ship/ (state.json +
                 review files), and /verify/ — never committed)
═══════════════════════════════════════════════════
```
