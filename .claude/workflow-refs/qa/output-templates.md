# /qa Phase 3 / Phase 9 — Output templates

## Markdown iteration report (`$QA_DIR/reports/qa-report-iteration-{N}.md`, also printed)

```markdown
# QA Report: [Feature/Page Name]
**Date:** [date]
**Tester:** Claude QA (Senior)
**Target:** [URL]
**Depth:** [depth]
**Iteration:** [N] of [max]

## Summary
| Category | Passed | Failed | Skipped |
|----------|--------|--------|---------|
| Happy Path | X | X | X |
| Form Validation | X | X | X |
| Error States | X | X | X |
| Edge Cases | X | X | X |
| Accessibility | X | X | X |
| Responsive | X | X | X |
| Performance | X | X | X |
| **Total** | **X** | **X** | **X** |

## Delta vs previous iteration   (iteration >= 2 only — REQUIRED on re-tests)
- **FIXED:** bugs from previous iteration that now pass
- **REGRESSION:** new bugs introduced by the fixes
- **STILL OPEN:** bugs that persist (keep the original BUG-ID)

## Critical Issues (P0)
### [BUG-001] [Short description]
- **Steps to reproduce:** ...
- **Expected:** ...
- **Actual:** ...
- **Screenshot:** [path]
- **Console errors:** [if any]
- **Fix hint:** [suggestion]
- **Files likely involved:** [if identifiable from error/stack trace]

## Major Issues (P1)
### [BUG-002] ...

## Minor Issues (P2)
### [BUG-003] ...

## Observations (P3)
...

## Passed Tests
<details>
<summary>Click to expand (X tests passed)</summary>

| # | Category | Scenario | Result | Screenshot |
|---|----------|----------|--------|------------|
| 1 | Happy Path | ... | PASS | ... |

</details>
```

## HTML artifact (`$QA_DIR/reports/report.html`)

One self-contained page covering ALL iterations so far: the summary table, the per-iteration delta (FIXED / REGRESSION / STILL OPEN), and every open bug with steps, expected/actual, and console errors.

- Embed the baseline screenshot and each failure's screenshot as `data:` URIs — no external references (a strict CSP blocks them).
- Keep it under 16MB: if screenshots push it over, embed only failure screenshots, then only P0/P1 ones, and reference the rest by filename.
- Write the page with `{{IMG:filename}}` placeholders, then run a small python/bash script that base64-encodes the image files and substitutes them in. NEVER write or edit base64 image data through Write/Edit — streaming megabytes of encoded pixels through the model is the failure this prevents.
- Stable `<title>`: the feature name, not a generic label.
- Load the `artifact-design` skill first if available, then publish:
  `Artifact(file_path="<literal $QA_DIR>/reports/report.html", icon="test", description="QA report for <feature>")`
- Re-publish the SAME file path every iteration (same path → same URL; a new path creates a second artifact).

## Phase 9 final console summary

```
═══════════════════════════════════════════════════
  /qa COMPLETE — [Feature Name]
═══════════════════════════════════════════════════

  Iterations:     {N} of {max}
  Final result:   ALL CLEAN | {X issues remaining}

  Iteration History:
  ┌──────────┬────────┬────────┬───────────────────┐
  │ Iter     │ Bugs   │ Fixed  │ Status            │
  ├──────────┼────────┼────────┼───────────────────┤
  │ 1        │ 5      │ —      │ 5 bugs found      │
  │ 2        │ 1      │ 4      │ 4 fixed, 1 new    │
  │ 3        │ 0      │ 1      │ ALL CLEAN         │
  └──────────┴────────┴────────┴───────────────────┘

  Report:    <QA report artifact URL from $QA_DIR/artifact-url.txt>

  Working files (under $QA_DIR — inside .git/, never committed):
    reports/qa-report-iteration-{1..N}.md · reports/code-review-iteration-{1..N-1}.md
    fixes/fix-*.md · screenshots/iteration-{1..N}/

═══════════════════════════════════════════════════
```

If issues remain, follow with:
```
REMAINING ISSUES (not auto-fixable):
- [BUG-003] P1: Form accepts invalid email — may need backend validation
- [BUG-007] P2: Modal z-index conflict — needs design decision
```
