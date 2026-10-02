---
description: Post-feature code optimization — shrink and dedupe the code you just wrote (dead code, duplication, needless abstraction, leftovers) without changing behavior, verified by lint/typecheck/tests after every batch
argument-hint: [--base BRANCH] [--path PATH ...] [--all] [--dry-run] [--aggressive | --safe-only] [--no-tests]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, TaskCreate, TaskUpdate, TaskList
---

# /optimize — Reduce & Clean Up After a Feature

Run this after a feature is complete. Goal: **less code, same behavior.** Remove what's unnecessary, collapse what's duplicated, simplify what's over-built — then prove nothing broke. Generic: works in any git repo (JS/TS, Python, .NET, Go, Rust, …).

## Arguments

User invoked with: `$ARGUMENTS`

- `--base BRANCH` — branch to diff against (default: `main`, else `master`)
- `--path PATH` — restrict scope to these paths (repeatable). Overrides the diff scope.
- `--all` — scope is the whole repo, not just the feature diff (slower; use sparingly)
- `--dry-run` — analyze and print the plan only; change nothing
- `--aggressive` — also apply `needs-care` findings (default: only `safe` ones are applied automatically; `needs-care` ones are listed and asked about once)
- `--safe-only` — apply only `safe` findings and never ask (non-interactive; used by `/ship`)
- `--no-tests` — skip running tests during verification (lint + typecheck still run)

## Hard Rules

- **Behavior-preserving only.** No feature changes, no "while I'm here" rewrites, no API/contract changes, no changing outputs, error messages, or log formats that something might depend on.
- **Every deletion needs evidence.** "Unused" means you searched for references (including string/dynamic usage, reflection, DI registration, route/file-system conventions, config files, templates, tests) and found none. No evidence → don't delete.
- **Never touch:** generated code, migrations, lockfiles, vendored code, public/exported library API, `.env*`/secrets, CI config, files outside the scope (except to update call sites of something you consolidated).
- **Never weaken tests to make them pass.** Don't edit test assertions to fit. Only remove tests that are exact duplicates of another test.
- **Keep comments that explain *why*.** Remove only comments that restate the code, commented-out code, and stale TODOs for things already done.
- **Don't trade clarity for line count.** No code golf, no dense one-liners, no nested ternaries. A slightly longer clear version beats a shorter clever one.
- **Clean tree in, one commit per verified batch out.** The run starts only from a clean working tree (Stage 0), so every state is recoverable with plain git. Each batch that passes checks becomes its own commit; failed batches are discarded, never committed.
- **Never force-push, never push, never rewrite existing commits.** No AI attribution in commits. Never stage `.env*`, `*.pem`, `credentials*`.
- **Every Bash call sets an explicit `timeout`** (quick git/grep: `10000`; lint/typecheck: `180000`; tests/build: `300000`).

## Subagents & Model Routing

The main session is the **orchestrator**: it owns scope, the checkpoint, the plan, user questions, and the final decision on every finding. Heavy reading, editing, and check-running go to subagents via the `Agent` tool so the main context stays small. Always pass `model` explicitly — pick by how much judgment the task needs:

| Task | Agent type | `model` | Why |
|---|---|---|---|
| Run lint/typecheck/tests, diff against baseline, summarize failures | `general-purpose` | `haiku` | Mechanical: run commands, compare lists |
| Run static tools (knip, vulture, ruff, jscpd…) and filter to scope | `general-purpose` | `haiku` | Mechanical: run + filter output |
| Leftovers finder (debug logs, commented code, stale TODOs, unused imports) | `general-purpose` | `haiku` | Pattern matching, low judgment |
| Dead-code finder (unused functions/exports/files/deps) | `general-purpose` | `sonnet` | Needs reference tracing incl. dynamic usage |
| Efficiency finder | `performance-engineer` | `sonnet` | Focused, evidence-based |
| Duplication finder (incl. "this already exists elsewhere") | `general-purpose` | `opus` | Needs whole-codebase understanding |
| Over-engineering finder | `code-simplifier:code-simplifier` | `opus` | Design judgment about abstractions |
| Adversarial verifier for each `needs-care` finding | `general-purpose` | `opus` | Must find the reason *not* to delete |
| Applying a batch of edits | `general-purpose` | `sonnet` (`opus` for over-engineering/duplication batches) | Precise multi-file edits |

Rules for subagents:
- Independent agents launch as **parallel `Agent` calls in one message**.
- Every prompt includes: the scope file list, base branch, the Hard Rules above verbatim, and the exact return format. Agents are read-only unless they are an "apply" agent; apply agents may only edit files named in their batch plus call sites.
- Agents return structured findings, not file dumps. The orchestrator never trusts a finding without the evidence field.
- Apply agents for different batches run **sequentially** (they'd conflict on files); finders and verifiers run in parallel.

## Stage 0 — Clean Tree, Scope & Checkpoint

1. Confirm a git repo: `git rev-parse --show-toplevel`. Resolve base branch (`--base`, else `main`, else `master`). Refuse to run on the base branch itself.
2. **Require a clean working tree.** `git status --porcelain` must be empty (untracked files included). If it isn't:
   - Called from `/ship` → this can't happen (`/ship` guarantees a clean tree); if it does, STOP.
   - Standalone → show the dirty files and ask the user **once**: commit them now as `wip: snapshot before /optimize` (refusing if any `.env*`/`*.pem`/`credentials*` would be staged), or abort. Never stash, never discard, never commit without that answer.
   Also refuse if a merge/rebase/cherry-pick is in progress (`.git/MERGE_HEAD`, `.git/rebase-*`, `.git/CHERRY_PICK_HEAD`).
3. **Checkpoint:** `git update-ref refs/optimize/checkpoint HEAD` and record the SHA in `$(git rev-parse --absolute-git-dir)/optimize/checkpoint.txt`. Print it with the undo command so the user has it before anything changes:
   `Checkpoint <sha> — undo everything: git reset --hard refs/optimize/checkpoint`
4. Resolve scope:
   - `--path` given → those paths.
   - `--all` → all tracked source files.
   - Otherwise → files changed on this branch: `git diff --name-only $(git merge-base HEAD <base>) HEAD`.
   - Drop generated/vendored/lock/migration/asset files from the list.
5. Record starting size: `git diff --shortstat <base>...HEAD` and a line count of in-scope files (`wc -l`).
6. Create tasks with TaskCreate for each stage below.

## Stage 1 — Baseline

Dispatch a **check-runner agent (`haiku`)** to detect the stack and run the project's own checks (prefer scripts from `package.json`/`Makefile`/`justfile`/`pyproject.toml` over guesses), lint + typecheck + tests in parallel. It returns the exact commands it used (reuse them in later stages) and a pass/fail summary — not raw logs:

| | JS/TS | Python | .NET | Go | Rust |
|---|---|---|---|---|---|
| Lint | `<pm> run lint` | `ruff check` | `dotnet format --verify-no-changes` | `go vet ./...` | `cargo clippy` |
| Typecheck | `tsc --noEmit` | `mypy`/`pyright` if configured | `dotnet build --nologo` | `go build ./...` | `cargo check` |
| Tests | `<pm> test` | `pytest` | `dotnet test --nologo` | `go test ./...` | `cargo test` |

Save the list of **pre-existing failures** to `$(git rev-parse --git-dir)/optimize/baseline.txt`. Later stages only fail on *new* failures. If the baseline is badly broken (build fails), stop and tell the user — you can't verify behavior preservation on a broken build.

## Stage 2 — Analyze (parallel)

### 2a. Run available static tools — **tools agent (`haiku`)**, in parallel with the Stage 1 check-runner

Only tools already installed/configured — never add dependencies.

- JS/TS: `npx --no-install knip`, `npx --no-install ts-prune`, `npx --no-install depcheck`, `npx --no-install jscpd <scope>` (duplication)
- Python: `ruff check --select F401,F841,ERA001,PIE,SIM <scope>`, `vulture <scope>` if installed
- .NET: build warnings `CS0168,CS0219,IDE0051,IDE0052,IDE0060`
- Go: `staticcheck ./...` if installed (U1000 = unused)

Filter output to in-scope files (plus anything in-scope code made unused elsewhere).

### 2b. Fan out review agents

Launch all five finders as **parallel `Agent` calls in a single message**, using the agent type and model from the routing table. Each gets the scope file list, the base branch, and the tool output from 2a, and returns findings as a list of: `file:line`, category, what to change, evidence (grep results showing no/duplicate references), estimated lines removed, risk (`safe` | `needs-care`).

1. **Leftovers** (`haiku`) — commented-out code, debug logs/prints, stale TODOs, unused imports/variables, restating comments.
2. **Dead code** (`sonnet`) — unused functions/classes/exports/params/types/CSS classes/feature flags/config keys/dependencies; unreachable branches; files nothing imports.
3. **Duplication** (`opus`) — copy-pasted blocks within the feature, *and* feature code that re-implements something that already exists in the codebase (search utils/helpers/shared modules/components). Prefer reusing the existing thing over creating a new abstraction.
4. **Over-engineering** (`opus`, `code-simplifier:code-simplifier`) — abstractions with a single implementation/caller, pass-through wrappers, needless indirection layers, premature generalization (options nobody passes), redundant null checks/try-catch on things that can't fail, defensive code duplicating framework guarantees, verbose patterns with an idiomatic shorter form in this codebase.
5. **Efficiency** (`sonnet`, `performance-engineer`) *(only obvious wins)* — repeated work in loops, N+1 queries, redundant re-computation/re-renders, sequential awaits that are independent. Skip anything speculative.

## Stage 3 — Triage & Plan

1. Merge and de-duplicate findings. Spot-check `safe` deletions yourself with a quick Grep (agents miss dynamic usage). Downgrade to `needs-care` or drop anything that touches: public exports, serialization/DTO shapes, reflection/DI, framework conventions (routes, pages, handlers, decorators), anything referenced by string.
   Then send every `needs-care` finding to an **adversarial verifier agent (`opus`)** — one agent per finding (or per group of related findings), all in parallel — whose job is to find a reason the change would break something. Verdict `refuted` → drop; `confirmed` → keep as `needs-care` with the verifier's note.
2. Drop findings that conflict with each other or that would make code less clear.
3. Print the plan:

```
#  Category        Location                    Change                                   ~Lines  Risk
1  dead-code       src/api/users.ts:42         remove unused formatUserLegacy()          -18    safe
2  duplication     src/ui/Table.tsx:80-120     reuse existing <DataTable> from shared     -35    safe
3  over-engineer   src/svc/cache.ts            inline single-use CacheFactory             -22    needs-care
...
Estimated total: -N lines
```

- `--dry-run` → stop here.
- `--safe-only` → drop `needs-care` items (list them in the report as skipped) without asking.
- Neither flag and there are `needs-care` items → ask the user **once** which (if any) to include. `safe` items proceed without asking.

## Stage 4 — Apply in Verified Batches

Apply in this order, one batch per category: **leftovers → dead code → duplication → over-engineering → efficiency.** Cheapest, safest first.

For each batch (sequentially — never two apply agents at once):
1. Dispatch an **apply agent** (`sonnet`; `opus` for duplication/over-engineering batches) with the batch's findings. It makes the edits (match surrounding style; update every call site), runs the formatter if the project has one, and returns the list of files it touched.
2. Dispatch the **check-runner agent (`haiku`)** with the Stage 1 commands and `baseline.txt`; it runs lint + typecheck + tests (tests skipped if `--no-tests`) and returns only *new* failures.
3. Orchestrator compares against baseline. The tree was clean before the batch, so `HEAD` is always the last good state:
   - No new failures → commit the batch: `git add -A && git commit -m "refactor(optimize): <category> — <short summary>"` (secret-path guard first). Mark findings applied.
   - New failures → discard the batch back to `HEAD`: `git reset --hard HEAD && git clean -fd -- <files the apply agent reported creating>` (never a bare `git clean`). If the batch had multiple findings, re-apply half and retest to find the culprit, commit the good ones, drop the culprit. Give up on isolating after two attempts and drop the whole batch. Record dropped items as `skipped (broke: <test/error>)`.
4. Never "fix" a failure by changing tests or adding new behavior.

## Stage 5 — Report

1. Final full run of lint + typecheck + tests + build (if the project has one) via the check-runner agent (`haiku`) — must match baseline. If not, `git reset --hard` to the last batch commit that passed, re-run, and say so.
2. Measure: `git diff --shortstat refs/optimize/checkpoint HEAD` → net lines removed. `git status --porcelain` must be empty at the end.
3. Print:

```
/optimize — <scope description>
Net: -312 lines (+41 / -353) across 14 files

Applied (N):  leftovers 6 · dead-code 9 · duplication 4 · over-engineering 3 · efficiency 1
Skipped  (M): <item> — <reason (needs-care declined / broke tests / unverifiable)>

Checks: lint ✓  typecheck ✓  tests ✓ (same as baseline)  build ✓
Commits: 5 (refactor(optimize): …)   git log --oneline refs/optimize/checkpoint..HEAD
Undo all: git reset --hard refs/optimize/checkpoint   ·   undo one batch: git revert <sha>
```

4. Leave `refs/optimize/checkpoint` in place (overwritten on the next run) so the user can undo. If nothing was applied, say so — there are no commits and the tree is unchanged.
