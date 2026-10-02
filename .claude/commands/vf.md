---
description: End-to-end verify the current feature branch before opening a PR (gated pipeline — browser check, local CI, then PR)
argument-hint: [feature description] [--port N] [--route PATH] [--start CMD] [--health URL] [--base BRANCH] [--no-pr] [--no-rebase] [--skip-browser] [--with-worker] [--no-worker] [--worker CMD] [--use-mcp] [--no-smoke] [--no-e2e] [--e2e-only PATH] [--qa-passed]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill, Artifact, TaskCreate, TaskUpdate, TaskList
---

# /vf — Verify Feature

Gated pipeline before opening a PR: any stage failure stops the run. Generic — works in any git repo.

Reference files (installed at `~/.claude/workflow-refs/vf/`) — Read each ONLY at the point stated:
- `detect.md` — per-stack detection (framework/port/start, CI commands, e2e signals, worker commands + decision). **Always** Read before Stage 0 — even when `--port`/`--start` are passed, worker detection and the package-manager/runner mapping for Stage 4 live only here. Skip only with `--skip-browser` plus an explicit `--worker`/`--no-worker`.
- `worker.md` — queue-backend checks, start, ready markers. Read when Stage 1b runs.
- `smoke.md` — `playwright-cli` smoke script, `--use-mcp`, pass criteria. Read when Stage 2a runs.
- `e2e.md` — spec templates, single-spec run commands, pass criteria, artifact capture. Read when Stage 2b/2c run.
- `pr.md` — report.html artifact + PR body template. Read before Stage 5.

## Arguments

User invoked with: `$ARGUMENTS`

- **Feature description** — any non-flag text (used in PR body)
- `--port N` — dev server port
- `--route PATH` — feature route to verify (e.g. `/dashboard`)
- `--start CMD` — dev server start command (e.g. `npm run dev`)
- `--health URL` — health check URL (default `http://localhost:<port>/`)
- `--base BRANCH` — base for rebase + PR (default `main`, else `master`)
- `--no-pr` — verify only, no PR
- `--no-rebase` — skip the Stage 0 rebase
- `--skip-browser` — skip Stages 1–2 (non-web projects)
- `--with-worker` / `--no-worker` — force-start / force-skip the background worker
- `--worker CMD` — explicit worker start command (e.g. `dotnet run --project src/Acme.Worker`)
- `--use-mcp` — allow Playwright MCP for the Stage 2a smoke check (default: CLI only)
- `--no-smoke` — skip Stage 2a (e.g. re-running after writing the spec)
- `--no-e2e` — skip Stage 2b/2c and the Stage 4 full e2e suite even if configured
- `--e2e-only PATH` — run only this spec in Stage 2c (full suite still runs in Stage 4)
- `--qa-passed` — `/qa` already verified the feature in the browser. Skips Stage 2a and reuses the QA run's screenshots and report artifact (via the QA `latest-run` pointer) as PR evidence. Stages 2b/2c and 4 still run.

Missing values: auto-detect, else ask the user **once** with a recommended default. Never silently invent values. Don't ask when reasonable defaults exist — echo and proceed.

## Hard Rules

- **Stop on any failure.** No later stage and no PR if anything in Stages 0–4 fails.
- **Never force-push** (no `--force` / `--force-with-lease`). Never push to the base branch.
- **Never auto-resolve merge conflicts.** On rebase conflict, abort and report.
- **Never bypass verifications** (no `--no-verify`, no skipping hooks).
- **No AI attribution** in commits or PR body unless the user asks.
- **Never read or commit secrets** (`.env*`, `*.pem`, `credentials*`).
- **Never commit verification or QA evidence.** It all lives under `$VF_DIR` (inside `.git/`, untrackable); human-facing reports are Claude Artifacts.
- **Every Bash call MUST set an explicit `timeout`** from the table below.
- **Use TaskCreate/TaskUpdate for every stage** (see Task Tracking).
- **Never invent a PR URL** — print only what `gh pr create` returned.

## Timeouts

On timeout, stop the stage and surface the stall — do not retry with a higher value; the timeout is the signal.

| Command class | Examples | `timeout` (ms) |
|---|---|---|
| Quick local checks | `git status`, `git rev-parse`, `git diff`, `command -v`, `lsof`, `test -f` | `10000` |
| Auth / network probes | `gh auth status`, `gh --version`, single `curl` health probe, `redis-cli ping` | `15000` |
| Git network ops | `git fetch`, `git push`, `git rebase origin/<base>` | `60000` |
| Single Playwright CLI action | `playwright-cli open/snapshot/click/fill/screenshot/close` | `30000` |
| Lint / format / typecheck | `<pm> run lint`, `ruff check`, `dotnet format --verify-no-changes`, `tsc --noEmit`, `mypy` | `180000` |
| Unit tests | `<pm> test`, `pytest`, `dotnet test --nologo` | `300000` |
| Production build | `<pm> run build`, `dotnet build -warnaserror` | `300000` |
| Single e2e spec (Stage 2c) | `npx playwright test <spec>`, `dotnet test --filter`, `pytest <spec>` | `300000` |
| Full e2e suite (Stage 4) | `npx playwright test`, `pytest tests/e2e/`, `dotnet test <E2E-project>` | `600000` |
| PR creation | `gh pr create`, `gh repo view` | `60000` |
| Readiness polling loops | `for i in $(seq …)` server/worker polls | `120000` (wall clock); inner `curl` keeps 15s |

Background processes (dev server, worker) use `run_in_background: true` and have no wall-clock timeout; their readiness polling is bounded (server 90s, worker 30s). 600000 is the Bash maximum — if a command legitimately needs longer, split it (smoke subset first), use the project's CI runner, or run it outside `/vf`. Never silently truncate.

## Auto-detection (before Stage 0)

Resolve (Read `detect.md` per the rule above):
1. **Stack** — .NET / Python / JS-TS (polyglot: the one matching the branch's changes, or ask). Framework → start command + port. Port: `--port`, else env, else framework default.
2. **Base branch** — `git symbolic-ref refs/remotes/origin/HEAD` minus prefix; else `main`, then `master`.
3. **CI commands** — see Stage 4 table; skip scripts that don't exist. Use the stack's runner (`uv run`, `poetry run`, `<pm> run`).
4. **E2E (optional)** — `playwright.config.*` / `e2e/` / `tests/e2e/` / `apps/*/e2e/`, a `Microsoft.Playwright.*` test `.csproj`, or `pytest-playwright`. If found, capture full-suite command, expected `baseURL` (must match the dev server URL — surface a mismatch), and spec naming convention. If not found, skip 2b/2c and the Stage 4 suite gracefully — **never scaffold or prompt to create one**. Echo `E2E: <runner> @ <path>` or `E2E: not configured — skipping spec/suite steps`.
5. **Worker** — detect one (or take `--worker`), then start it only if the feature needs it (async/queue/email/notification/background/job/webhook/schedule in the description, branch diff touches worker code, Stage 2 enqueues a job whose effect must be asserted, or `--with-worker`). `--no-worker` always wins. Detected-but-unneeded → echo `Worker: detected but not required for this feature (skipping). Pass --with-worker to force.`

Echo stack, port, start command, worker command + reason, and CI commands before Stage 0 so the user can correct.

## Task Tracking (MANDATORY)

Before Stage 0, TaskCreate one task per stage that will actually run:

```
"Stage 0: Prepare branch — check tools, commit, rebase"
"Stage 1: Start application"                 (skip if --skip-browser)
"Stage 1b: Start worker"                     (only if worker needed)
"Stage 2a: Smoke check"                      (skip if --skip-browser, --qa-passed or --no-smoke)
"Stage 2b: Author/update e2e spec"           (only if e2e configured)
"Stage 2c: Run e2e spec"                     (only if e2e configured)
"Stage 3: Stop server and worker"
"Stage 4: Local CI — lint, typecheck, tests, build"
"Stage 5: Open PR"                           (skip if --no-pr)
```

TaskUpdate each to `in_progress` on entry and `completed` on exit. Before stopping or reporting (success or failure), call TaskList; every task must end terminal — complete it or update its description with why it was skipped. No orphaned tasks.

## Stage 0 — Prepare Branch

1. `git rev-parse --abbrev-ref HEAD` — **refuse** if on the base branch. Then:
   ```bash
   VF_DIR="$(git rev-parse --absolute-git-dir)/verify"
   mkdir -p "$VF_DIR"
   ```
   `$VF_DIR` always means this absolute path.
2. Check tools: `git --version`; `gh --version` + `gh auth status` if a PR is requested (unauthenticated → stop before pushing, tell the user to run `gh auth login`). If Stage 2 will run:
   - `@playwright/cli` (Stage 2a): if `playwright-cli --help` fails, `npm i -g @playwright/cli@latest`.
   - `@playwright/test` (2b/2c): use the project's e2e install; never install globally.
   - `npx playwright install chromium` (idempotent) — skipping it is the #1 cause of `Executable doesn't exist at ...chrome-headless-shell`.
3. `git status --porcelain` — if dirty, `git add -A`, but bail out and ask if `.env`, `*.pem`, or `credentials*` got staged. Commit with a one-line subject derived from the diff.
4. Unless `--no-rebase`: `git fetch origin <base>` then `git rebase origin/<base>`. On conflict: `git rebase --abort`, STOP, report conflicting files.

## Stage 1 — Start Application (skip if `--skip-browser`)

1. Free the port: `lsof -ti tcp:<port> | xargs -r kill -9` (Windows: `npx kill-port <port>`).
2. Start in the background:
   ```bash
   nohup <start-cmd> > "$VF_DIR/server.log" 2>&1 &
   echo $! > "$VF_DIR/server.pid"
   ```
3. Poll the health URL every 2s for up to **90s**; 200/302/401 = up. On timeout: kill the server, dump the last 50 lines of `server.log`, STOP.

## Stage 1b — Start Worker (only if needed per auto-detection)

Read `~/.claude/workflow-refs/vf/worker.md` and follow it (backend check → start → `$VF_DIR/worker.{log,pid}` → 30s ready wait → on failure dump log, kill server, STOP).

## Stage 2 — Browser Verification (skip if `--skip-browser`)

When an e2e suite exists, tests belong there — no standalone verification scripts (they bit-rot and don't run in CI). Without one, the 2a smoke check IS the verification. On any failure in 2a/2b/2c: STOP, leave server (and worker) running for inspection, report what failed and where.

### 2a — Smoke check

- **`--qa-passed`:** skip the smoke check and instead:
  ```bash
  QA_BASE="$(git rev-parse --absolute-git-dir)/qa"
  QA_DIR="$QA_BASE/$(cat "$QA_BASE/latest-run")"
  cp "$QA_DIR/screenshots/iteration-$(cat "$QA_DIR/current-iteration")"/*.png "$VF_DIR/" 2>/dev/null || true
  ```
  If that iteration's `00-initial-state.png` exists, copy it to `$VF_DIR/smoke.png`. Read `$QA_DIR/result.json` (iterations, `bugs_found_total`, `bugs_fixed_total`, `remaining`, `artifact_url`) for Stage 5; fall back to `artifact-url.txt` + markdown reports only if `result.json` is missing. Echo `Stage 2a: skipped (QA-verified — report: <artifact URL>)` and go to 2b.
- **`--no-smoke`:** skip.
- **Otherwise:** Read `~/.claude/workflow-refs/vf/smoke.md` and run it (session `-s=vf`, evidence in `$VF_DIR/smoke.png`). If smoke fails, STOP before writing a spec.

### 2b / 2c — E2E spec (only if e2e configured and not `--no-e2e`)

Read `~/.claude/workflow-refs/vf/e2e.md`. 2b: write/extend the spec in the project's existing e2e dir following neighbor specs (never scaffold). 2c: run **only** that spec (or `--e2e-only PATH`); green + clean console + worker side effect verified if a worker runs. Capture report summary/traces and `$VF_DIR/screenshot.png`.

## Stage 3 — Stop Server and Worker

1. Worker first (lets final job writes flush): `kill -9 $(cat "$VF_DIR/worker.pid") 2>/dev/null || true` if the pid file exists.
2. `kill -9 $(cat "$VF_DIR/server.pid") 2>/dev/null || true` if it exists.
3. `lsof -ti tcp:<port> | xargs -r kill -9`.

Required before Stage 4 — watchers (`dotnet watch`, `nodemon`, `uvicorn --reload`) holding file locks break builds.

## Stage 4 — Local CI

| Step | JS/TS | Python | .NET |
|------|-------|--------|------|
| Lint / format | `<pm> run lint` | `ruff check` + `ruff format --check` | `dotnet format --verify-no-changes` |
| Typecheck | `<pm> run typecheck` / `tsc --noEmit` | `mypy` / `pyright` (if configured) | covered by `dotnet build` analyzers |
| Unit tests | `<pm> test` | `pytest` (via `uv run` / `poetry run`) | `dotnet test --nologo` |
| Build | `<pm> run build` | skip for apps; `python -m build` for libs | `dotnet build -warnaserror --nologo` |
| Full e2e suite *(if configured)* | `npx playwright test` (or `<pm> --prefix e2e test`) | `pytest tests/e2e/` | `dotnet test <E2E-project> --nologo` |

1. Run lint, typecheck, unit tests as **parallel Bash calls in one message**; on failure report every failing step from the batch, then stop. **.NET:** only lint + unit tests in parallel (no typecheck call); build runs afterward, never in the batch — `dotnet format` and `dotnet test` race on `obj/`/`bin/` and fail with spurious file locks.
2. Then the build, sequentially.
3. **Full e2e suite** — only if e2e was detected and not `--no-e2e`; otherwise mark `— (no e2e)` and never create a setup. It needs the app: restart the app (and worker if Stage 1b ran — builds may have cleared `dist/` or killed watchers), wait for health, run the **full** suite (prefer a smoke subset first if one exists, e.g. `npm run test:e2e:smoke`, `pytest -m smoke`), then stop app + worker again. Surface flaky-test retries.

Print a results table (Lint / Typecheck / Unit tests / Build / E2E with ✓/✗). Any failure → surface output, STOP, no Stage 5.

## Stage 5 — Open PR (skip if `--no-pr`)

Read `~/.claude/workflow-refs/vf/pr.md` first.
1. Evidence stays under `$VF_DIR` / the QA run dir — never commit it.
2. Build and publish `$VF_DIR/report.html` as an Artifact per `pr.md`; save the URL to `$VF_DIR/artifact-url.txt`.
3. `git push -u origin HEAD` (never forced).
4. `gh pr create` with the `pr.md` body (QA section only with `--qa-passed`, numbers from `result.json`).
5. Print the PR URL.

## Output Format

At the end (success or failure):

```
/vf summary
  Branch:       <branch> → <base>
  Port / route: <port> <route>
  Worker:       <command or "not required">
  E2E suite:    <runner> · spec: <new-or-modified-spec>
  QA:           passed (3 iterations, 12 bugs found+fixed) | not run
  Stages:       0 ✓  1 ✓  1b ✓  2a ✓/⊘  2b ✓  2c ✓  3 ✓  4 ✓  5 ✓
  PR:           <url or "skipped">
  Report:       <verification artifact URL>{ · <QA report artifact URL> if --qa-passed}
  Working dir:  $VF_DIR (smoke.png, screenshot.png, server.log, worker.log,
                playwright-report summary — inside .git/, never committed)
```

⊘ = skipped as redundant via `--qa-passed` (not a failure). On failure, ✗ the failed stage and add a short reason on the next line.

## Cleanup (always, success or failure)

- TaskList audit — every task terminal (completed, or description says why skipped).
- `playwright-cli -s=vf close 2>/dev/null || true`.
- Kill the worker (`$VF_DIR/worker.pid`) and dev server (`$VF_DIR/server.pid`) if still running.
- Leave `$VF_DIR` in place as the audit trail (inside `.git/`; no `.gitignore` entry needed).
