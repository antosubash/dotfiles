# /vf — Stage 5: Report artifact + PR

Read by /vf before Stage 5 (skip when `--no-pr`).

## Verification report artifact

Build `$VF_DIR/report.html` — one self-contained page with:
- the stage results table,
- the smoke/final screenshot embedded as a `data:` URI (no external references — a strict CSP blocks them; keep the page under 16MB),
- the e2e outcome,
- if `--qa-passed`: a link to the QA report artifact.

Load the `artifact-design` skill first if available, then publish:
`Artifact(file_path="<literal $VF_DIR>/report.html", icon="check", description="Verification report for <feature>")`.
Save the returned URL to `$VF_DIR/artifact-url.txt`.

## PR body

```bash
gh pr create --base <base> --title "<short title>" --body "$(cat <<'EOF'
## Summary
<1–3 bullets describing the change, derived from commits + feature description>

## Verification
- Browser-verified at `<route>` on port `<port>`
- Console: no errors
- Local CI: lint / typecheck / tests / build all green
- Verification report: <verification artifact URL>

## QA Report
{IF --qa-passed: include this section — numbers from $QA_DIR/result.json, else omit}
- Full QA cycle completed ({iterations} iterations)
- {bugs_found_total} bugs found, {bugs_fixed_total} fixed
- Categories tested: Happy Path, Form Validation, Error States, Edge Cases{, Accessibility, Responsive, Performance if applicable}
- Full QA report: <QA report artifact URL>

> Report links are Claude Artifacts and start private — the author can share them
> from claude.ai/code/artifacts if reviewers need access.

## Test plan
- [ ] Reviewer loads `<route>` and confirms <key assertion>
- [ ] CI is green
EOF
)"
```

No AI attribution in the title or body unless the user asked.
