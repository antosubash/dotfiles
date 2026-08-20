---
description: Implement, review, and fix repeatedly until clean or the bounded iteration limit
argument-hint: "<task> [--max-iterations N]"
---

Run a bounded implementation convergence loop for:

$ARGUMENTS

Default `max_iterations` to 3 unless supplied.

1. Inspect repository instructions and status. Preserve unrelated work.
2. Dispatch `worker` to implement the task and run targeted checks.
3. Dispatch `reviewer` to review the complete task diff plus uncommitted changes.
4. If its final line is `VERDICT: CLEAN`, run the relevant validation yourself and stop successfully.
5. If findings remain, dispatch `worker` with the exact review output to fix actionable findings, then return to step 3.
6. Stop after `max_iterations`; report unresolved findings rather than claiming success.

Do not commit or push. A fix pass is never proof of cleanliness: always perform the next review pass.
