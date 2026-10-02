# /ship — why the convergence rules are shaped this way

Read only if a convergence decision is ambiguous or you are tempted to deviate from the rules in ship.md.

- **Why loop at all:** code review and QA both fix code, and fixing code can introduce new problems. So after either changes anything, re-review and re-test; open the PR only once a complete pass finds nothing left to fix.
- **Why Stage O runs before the loop:** optimization changes code, so review and QA then verify the optimized code — nothing ships that wasn't reviewed and tested after it was shrunk.
- **Why Stage A fixes don't force another round:** within a round, Stage A runs first and ends on a clean re-review pass, then Stage B tests exactly that reviewed code. A round where QA found nothing means the current code is both review-clean AND QA-clean — done, even if Stage A fixed things earlier in the round. Re-looping on review fixes alone would re-run a full `/qa` (server + agent fan-out) on code QA just passed — pure waste.
- **The one asymmetry:** QA's bug-fixes land after the last clean review, so they alone trigger the next round.
- **Why exit NOT-CLEAN when Stage A is unresolved and QA changed nothing:** those findings already survived `--max-review-iterations` passes with dev-agent help; with no new code from QA, an identical round would just repeat the same failure.
- **Why later review passes default to `medium`:** pass 1 already covered the span at full effort; later passes confirm fresh fixes and catch regressions. An explicit `--review-effort` is a user override and must hold for every pass — silently downgrading an explicit `max` (or upgrading an explicit `low`) would ignore the user.
- **Why REVIEW_TARGET advances to `last_clean_review_sha`:** everything up to a clean pass is reviewed code; re-reviewing the whole branch each round wastes the dominant token cost.
- **Cost:** the default cap of 3 rounds is usually plenty — with these rules most branches converge in exactly 1 round.
- **Why `/vf` CI failures don't loop back to `/qa`:** a failing build/test is a different problem class than a browser bug; report it and let the user decide.
