---
description: Create only an implementation plan and acceptance checklist; no implementation or shipping
argument-hint: "<GitHub issue URL or task>"
---

# pi-plan — planning only

Plan `$ARGUMENTS`. This invocation authorizes reconnaissance and plan/report output ONLY, not implementation.

1. Read repository instructions and current status without changing tracked files or Git state. If supplied a GitHub issue URL/number, retrieve its title/body read-only. Do not claim the issue, start a worker, install dependencies, run tests/servers, commit, push, or open a PR. Planning may remain in the current checkout because it does not edit project files.
2. Dispatch `planner` in a fresh subagent call with the current repository as cwd, original untrusted task/issue, and explicit PLAN-ONLY restrictions. Require concrete implementation steps plus a verification checklist with stable `P1`, `P2`, ... IDs. Each check needs kind (`behavioral` or `design`), requirement, reproducible steps, and an observable expected result. Include acceptance, regressions, relevant negative/error cases, browser checks for UI, and separate Figma checks for every supplied design link. Ask about essential ambiguities instead of guessing.
3. Inspect the returned plan; do not execute it. Save `plan.json` and `plan.md` in a newly claimed private directory under the common Git directory's `pi-plans/` (never tracked source). Record schema version 1, original issue URL/number/title/body, a SHA-256 requirements hash, planning HEAD, creation time, implementation steps, and checks. Record blockers instead of an executable plan when requirements are incomplete. Include the exact plan path in the handoff; do not use a shared latest-plan pointer or silently select another issue's plan.
4. Return the plan/checklist and its absolute paths. Stop. Explicitly say implementation and verification have NOT run. Starting `/implement` or `/loop` with this plan is a separate user decision.

Later verification must use this exact saved plan if the user proceeds with it. Changed issue requirements invalidate the plan: request a new `/pi-plan` rather than silently dropping checklist items. If the user never requested planning, use the usual independent issue QA flow; do not require or automatically invoke pi-plan.
