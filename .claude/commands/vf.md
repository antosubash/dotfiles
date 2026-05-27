---
description: End-to-end verify the current feature branch before opening a PR (gated pipeline — browser check, local CI, then PR)
argument-hint: [feature description] [--port N] [--route PATH] [--start CMD] [--health URL] [--no-pr]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, TaskCreate, TaskUpdate, TaskList
---

# /vf — Verify Feature

End-to-end verification of a feature implementation before opening a PR. Runs a **gated pipeline**: any stage failure stops the run. This command is generic and works in any git repo.

## Arguments

User invoked with: `$ARGUMENTS`

Parse `$ARGUMENTS` into:
- **Feature description** (free text, used in PR body) — anything not matching a flag
- `--port N` — port the dev server listens on
- `--route PATH` — feature route to verify in the browser (e.g. `/dashboard`)
- `--start CMD` — command to start the dev server (e.g. `npm run dev`)
- `--health URL` — health check URL (defaults to `http://localhost:<port>/`)
- `--base BRANCH` — base branch for rebase + PR (defaults to `main`, else `master`)
- `--no-pr` — skip PR creation (run verification only)
- `--no-rebase` — skip Stage 0 rebase step
- `--skip-browser` — skip Stage 2 browser checks (useful for non-web projects)
- `--with-worker` — force-start the background worker even if auto-detection says it's not needed
- `--no-worker` — force-skip the background worker even if it looks required
- `--worker CMD` — explicit command to start the worker (e.g. `dotnet run --project src/Acme.Worker`)
- `--use-mcp` — allow Playwright MCP for the Stage 2 smoke check (default: CLI only)
- `--no-smoke` — skip Stage 2a smoke check (e.g. when re-running after writing the spec)
- `--no-e2e` — skip Stage 2b/2c and the full e2e suite in Stage 4 even if e2e is configured
- `--e2e-only PATH` — run only this spec in Stage 2c (e.g. `tests/dashboard.spec.ts`). Full suite still runs in Stage 4.
- `--qa-passed` — indicates `/qa` already verified the feature in the browser. Skips Stage 2a (smoke check), reuses QA screenshots/reports as PR evidence. Stage 2b/2c (e2e specs) and Stage 4 (local CI) still run.

If a flag is missing, auto-detect (see "Auto-detection" below) or ask the user **once** for any value that cannot be inferred. Never silently invent values.

## Hard Rules

- **Stop on any failure.** Do NOT proceed to later stages or open a PR if anything in stages 0–4 fails.
- **Never force-push.** Never push to the base branch directly.
- **Never auto-resolve merge conflicts.** If rebase conflicts, abort and report.
- **Never bypass verifications** (no `--no-verify`, no skipping hooks).
- **No AI attribution** in commit messages or PR body unless the user asks.
- **Never read or commit secrets** (`.env*`, `*.pem`, `credentials*`).
- **Every Bash call MUST set an explicit `timeout`.** Never rely on the default. See "Timeouts" below.

## Timeouts

Every Bash tool invocation must pass an explicit `timeout` (milliseconds). Pick from this table; do not omit. If a command exceeds its timeout, stop the stage and surface the stall — do not retry with a higher value, the timeout itself is the signal something is wrong.

| Command class | Examples | `timeout` (ms) |
|---|---|---|
| Quick local checks | `git status`, `git rev-parse`, `git diff`, `command -v`, `lsof`, `test -f` | `10000` |
| Auth / network probes | `gh auth status`, `gh --version`, `curl` health probe (single), `redis-cli ping` | `15000` |
| Git network ops | `git fetch`, `git push`, `git rebase origin/<base>` | `60000` |
| Single Playwright CLI action | `playwright-cli open/snapshot/click/fill/screenshot/close` | `30000` |
| Lint / format / typecheck | `<pm> run lint`, `ruff check`, `dotnet format --verify-no-changes`, `tsc --noEmit`, `mypy` | `180000` |
| Unit tests | `<pm> test`, `pytest`, `dotnet test --nologo` | `300000` |
| Production build | `<pm> run build`, `dotnet build -warnaserror` | `300000` |
| Single e2e spec (Stage 2c) | `npx playwright test <spec>`, `dotnet test --filter`, `pytest <spec>` | `300000` |
| Full e2e suite (Stage 4) | `npx playwright test`, `pytest tests/e2e/`, `dotnet test <E2E-project>` | `600000` |
| PR creation | `gh pr create`, `gh repo view` | `60000` |
| Polling loops (server / worker readiness) | the `for i in $(seq …)` blocks below | `120000` (script wall clock); inner `curl` keeps its 15s |

**Background processes are exempt.** The dev server (Stage 1) and worker (Stage 1b) start via `run_in_background: true` and are not subject to a wall-clock timeout — they're meant to run for the verification's duration. Their *readiness polling* is bounded (Stage 1: 90s; Stage 1b: 30s).

**600000 ms is the Bash tool maximum.** If a real command would legitimately need longer (e.g. a 15-minute e2e suite), split it (run a smoke subset first), use the project's existing CI runner with its own time budget, or run it outside `/vf`. Do not silently truncate.

## Auto-detection

Before stages run, detect project shape:

Three first-class stacks: **JS/TS**, **Python**, **.NET**. Detect in this order (a repo can be polyglot — detect the one matching the feature branch's changes, or ask if ambiguous).

1. **Stack + framework**:
   - **.NET** — `*.sln`, `*.csproj`, `global.json`, or `Program.cs` present:
     - ASP.NET Core (Web API / Blazor / MVC). Default port from `Properties/launchSettings.json` `applicationUrl` (commonly 5000/5001 or 5xxx); fall back to 5000.
     - Multi-project solutions: prefer the project with `Microsoft.NET.Sdk.Web` SDK and `OutputType=Exe`. If multiple, ask the user.
   - **Python** — `pyproject.toml`, `requirements*.txt`, `manage.py`, or `setup.py` present:
     - `manage.py` → Django (port 8000, start `python manage.py runserver`)
     - `fastapi` / `uvicorn` in deps → FastAPI (port 8000, start `uvicorn <module>:app --reload`)
     - `flask` in deps → Flask (port 5000, start `flask --app <module> run --debug`)
     - Detect virtualenv: prefer `uv run`, then `poetry run`, then `.venv/bin/python`, else system `python`.
   - **JS/TS** — `package.json` present:
     - `next` → Next.js (port 3000, start `<pm> run dev`)
     - `vite` → Vite (port 5173)
     - `@remix-run/*` → Remix (port 3000)
     - `astro` → Astro (port 4321)
     - `nuxt` → Nuxt (port 3000)
     - `@sveltejs/kit` → SvelteKit (port 5173)
     - Package manager from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, else npm.
2. **Start command** — see per-stack defaults above. Always allow `--start` override.
3. **Port** — from arg, else env (`PORT` / `ASPNETCORE_URLS` in `.env*` or `launchSettings.json`), else framework default.
4. **Base branch** — `git symbolic-ref refs/remotes/origin/HEAD` → strip prefix; fall back to `main`, then `master`.
5. **Lint / typecheck / test / build commands** — by stack:
   - **.NET:** `dotnet format --verify-no-changes` (lint+format), `dotnet build -warnaserror --nologo` (build+analyzers = typecheck), `dotnet test --nologo`.
   - **Python:** `ruff check` + `ruff format --check` (lint+format), `mypy` or `pyright` if configured (typecheck), `pytest` (test), `python -m build` only if it's a library; for apps the build step is usually a no-op — skip rather than invent one.
   - **JS/TS:** `package.json` scripts (`lint`, `typecheck`/`type-check`, `test`, `build`). Skip any that don't exist.

Run each step with the stack's runner (`uv run pytest`, `poetry run pytest`, `pnpm run lint`, etc.) so deps resolve correctly.

6. **E2E setup (optional)** — try to locate an existing e2e configuration. If found, Stage 2b/2c and the full e2e step in Stage 4 are active. If not found, **skip them gracefully** — do NOT scaffold, do NOT prompt to create one. The smoke check in Stage 2a is still mandatory.

   Detection signals:
   - `playwright.config.{ts,js,mjs}` at repo root, `e2e/`, `tests/e2e/`, or `apps/*/e2e/`.
   - `.csproj` with `Microsoft.Playwright.NUnit` / `Microsoft.Playwright.MSTest` / `Microsoft.Playwright.Xunit` (typically `*.E2E.Tests` projects).
   - `pytest-playwright` in `pyproject.toml` / `requirements*.txt`, with tests under `tests/e2e/` or matching `test_*_e2e.py`.

   If detected, capture:
   - The command to run the full suite (e.g. `npm --prefix e2e test`, `dotnet test src/Acme.E2E.Tests`, `pytest tests/e2e/`) — derive from `package.json` scripts, `.csproj` test ID, or pytest paths.
   - The `baseURL` / equivalent env var the suite expects (Playwright config `use.baseURL`, often overridable via env). The dev server URL chosen in step 3 must match this — if not, surface the mismatch.
   - The spec naming convention (e.g. `<feature>.spec.ts`, `<Feature>Tests.cs`) so Stage 2b matches it.

   Echo `E2E: <runner> @ <path>` if detected, or `E2E: not configured — skipping spec/suite steps` if not. Pass `--no-e2e` to skip even when configured.

7. **Background worker** — many features rely on a queue/job worker (emails, notifications, image/file processing, webhooks, scheduled tasks). Detect a worker AND decide whether **this feature** needs it (see "Worker decision" below).

   **Worker detection** (by stack):
   - **.NET:** project with `Microsoft.NET.Sdk.Worker` SDK, or a class extending `BackgroundService` / `IHostedService` in a separate `*.Worker` / `*.Jobs` project. Packages: `Hangfire.*`, `Quartz`, `MassTransit`, `Coravel`. Start: `dotnet run --project <Worker>` (or `dotnet watch run --project <Worker>`).
   - **Python:** `celery` in deps → `celery -A <app> worker -l info`. `rq` → `rq worker`. `dramatiq` → `dramatiq <module>`. `arq` → `arq <module>.WorkerSettings`. Django-Q → `python manage.py qcluster`. Wrap with `uv run` / `poetry run` if applicable.
   - **JS/TS:** `package.json` scripts named `worker`, `jobs`, `queue`, or `worker:dev`. Packages: `bullmq`, `bull`, `bee-queue`, `agenda`, `inngest`. `Procfile` line `worker:` is a strong signal.
   - **Generic:** `Procfile` (Heroku/Foreman) with non-web processes — start the relevant line.

   **Worker decision** — only start the worker if at least one is true:
   - The feature description in `$ARGUMENTS` mentions async / queue / email / notification / background / job / webhook / schedule.
   - Files changed in this branch touch worker code (`git diff --name-only origin/<base>...HEAD` matches the worker project dir, `*tasks*`, `*jobs*`, `*queue*`, `*worker*`, `*BackgroundService*`, `*celery*`).
   - Browser interaction in Stage 2 enqueues a job whose side effect we need to assert.
   - The user passed `--with-worker` (force on) — never start when `--no-worker` is passed (force off).

   If a worker is detected but the decision logic says it's not needed, echo `Worker: detected but not required for this feature (skipping). Pass --with-worker to force.` and move on. If detected AND needed, record the worker command and start it in Stage 1b.

Echo what you detected (stack, port, start command, **worker command + reason**, CI commands) before starting Stage 0 so the user can correct.

---

## Task Tracking (MANDATORY)

**You MUST use TaskCreate and TaskUpdate throughout the entire /vf pipeline.** This gives the user real-time visibility into progress. Never skip this.

### Before Stage 0, create the full task list:

```
TaskCreate: "Stage 0: Prepare branch — check tools, commit, rebase"
TaskCreate: "Stage 1: Start application"                               (skip if --skip-browser)
TaskCreate: "Stage 1b: Start worker"                                   (only if worker needed)
TaskCreate: "Stage 2a: Smoke check"                                    (skip if --skip-browser or --qa-passed)
TaskCreate: "Stage 2b: Author/update e2e spec"                         (only if e2e configured)
TaskCreate: "Stage 2c: Run e2e spec"                                   (only if e2e configured)
TaskCreate: "Stage 3: Stop server and worker"
TaskCreate: "Stage 4: Local CI — lint, typecheck, tests, build"
TaskCreate: "Stage 5: Open PR"                                         (skip if --no-pr)
```

Only create tasks for stages that will actually run based on the detected flags and configuration. If `--skip-browser` is set, don't create Stage 1/2 tasks. If `--no-pr` is set, don't create Stage 5 task.

### As you enter each stage:
- `TaskUpdate` the stage task to `in_progress`

### As you complete each stage:
- `TaskUpdate` the stage task to `completed`

### Before stopping or reporting results:
**Always call TaskList to verify all tasks are completed or accounted for.** If any task is still `in_progress` or `pending`, either complete it or update its description with the reason it was skipped. Never stop with orphaned tasks.

---

## Stage 0 — Prepare Branch

**→ TaskUpdate:** Mark "Stage 0: Prepare branch" as `in_progress`. Create the full task list per the Task Tracking section above.

1. Run `git rev-parse --abbrev-ref HEAD`. **Refuse to continue** if on the base branch — instruct the user to switch to a feature branch.
2. Check tools:
   - `git --version` (required)
   - `gh --version` and `gh auth status` (required only if PR creation requested)
   - **Playwright tooling** (required only if Stage 2 will run):
     - **`@playwright/cli`** for the Stage 2a smoke check — install globally if missing: `npm i -g @playwright/cli@latest`, then verify with `playwright-cli --help`. (Source: https://github.com/microsoft/playwright-cli — designed for agent use, ships as the `playwright-cli` binary.)
     - **`@playwright/test`** for the durable e2e specs (Stage 2b/2c) — use whatever the project already has installed in its e2e workspace. Do NOT install it globally.
     - **Browser binary** — chromium must be downloaded for both. Run `npx playwright install chromium` (idempotent, no-op if already present). Skipping this is the #1 cause of `Executable doesn't exist at ...chrome-headless-shell`.
3. Run `git status --porcelain`. If there are pending changes:
   - Stage tracked changes with `git add -A` (but **skip secret-like paths** — bail out if `.env`, `*.pem`, or `credentials*` are staged; ask the user).
   - Commit with a descriptive message derived from the diff (one short subject line, no AI attribution).
4. Unless `--no-rebase`: `git fetch origin <base>` then `git rebase origin/<base>`.
   - On conflict: run `git rebase --abort` and STOP. Report the conflicting files.

**→ TaskUpdate:** Mark "Stage 0: Prepare branch" as `completed`.

## Stage 1 — Start Application

Skip this stage if `--skip-browser` is set.

**→ TaskUpdate:** Mark "Stage 1: Start application" as `in_progress`.

1. Kill anything bound to the port: `lsof -ti tcp:<port> | xargs -r kill -9` (Linux/macOS). On Windows, use `npx kill-port <port>`.
2. Start the dev server in the background. Redirect output to `.verify/server.log`:
   ```bash
   mkdir -p .verify
   nohup <start-cmd> > .verify/server.log 2>&1 &
   echo $! > .verify/server.pid
   ```
3. Poll the health URL (default `http://localhost:<port>/`) every 2s for up to **90 seconds**. Accept HTTP 200, 302, or 401 as "up". On timeout, kill the server, dump the last 50 lines of `.verify/server.log`, and STOP.

**→ TaskUpdate:** Mark "Stage 1: Start application" as `completed`.

## Stage 1b — Start Worker (if needed)

Skip if auto-detection said worker is not needed and `--with-worker` was not passed. Skip if `--no-worker` was passed.

**→ TaskUpdate:** Mark "Stage 1b: Start worker" as `in_progress`.

1. Ensure the worker's queue backend is reachable before starting (else the worker will crash-loop):
   - **Redis** (BullMQ, RQ, Celery-with-Redis, Sidekiq) — `redis-cli -u "$REDIS_URL" ping` (or default `redis://localhost:6379`). If unreachable, attempt `docker compose up -d redis` only if `docker-compose.yml` / `compose.yaml` defines a `redis` service; otherwise STOP and tell the user to start Redis.
   - **RabbitMQ / AMQP** (Celery, MassTransit) — check `$RABBITMQ_URL` / `amqp://localhost:5672` with `curl -sf http://localhost:15672/api/aliveness-test/%2F -u guest:guest` if the management plugin is on; same docker-compose fallback.
   - **DB-backed queues** (Hangfire SQL, Django-Q ORM, pg-boss) — the app's existing DB connection is enough; nothing extra to start.
2. Start the worker in the background. Same pattern as the web server:
   ```bash
   nohup <worker-cmd> > .verify/worker.log 2>&1 &
   echo $! > .verify/worker.pid
   ```
3. Wait up to **30 seconds** for a "ready" signal in `.verify/worker.log`. Look for stack-specific markers:
   - Celery: `celery@<host> ready` / `mingle: all alone`
   - BullMQ: worker `ready` event, or `Worker started`
   - Hangfire: `Server <name> successfully announced`
   - .NET `BackgroundService`: app host `Application started`
   - Generic fallback: just confirm the PID is still alive after 5 seconds and the log has no fatal/exception lines.
4. On timeout or crash: dump the last 50 lines of `.verify/worker.log`, kill the web server, and STOP.

**→ TaskUpdate:** Mark "Stage 1b: Start worker" as `completed`.

## Stage 2 — Browser Verification

Skip if `--skip-browser` is set. This stage has **three sub-steps**: smoke, spec, run. The smoke step is exploratory; the spec step is the durable artifact; the run step gives fast feedback before Stage 4.

**Core principle:** when an e2e suite exists, tests belong there. Verification scripts outside the e2e suite are an anti-pattern — they bit-rot, don't run in CI, and create two parallel test taxonomies. When no e2e suite exists, the `@playwright/cli` smoke check in 2a IS the verification — don't fabricate a parallel one.

### Stage 2a — Smoke check via `@playwright/cli`

**→ TaskUpdate:** Mark "Stage 2a: Smoke check" as `in_progress`.

**If `--qa-passed` is set:** skip this sub-stage entirely. `/qa` already did comprehensive browser testing. Instead:
1. Copy the final QA screenshot into `.verify/`: `cp .qa/screenshots/iteration-$(cat .qa/current-iteration)/*.png .verify/ 2>/dev/null || true`
2. If `.qa/screenshots/iteration-$(cat .qa/current-iteration)/00-initial-state.png` exists, copy it to `.verify/smoke.png`
3. Echo `Stage 2a: skipped (QA-verified — see .qa/reports/)`
4. Proceed directly to Stage 2b.

Fast exploratory pass using the **`@playwright/cli`** tool (binary: `playwright-cli`). Goal: prove the app actually serves the feature route, the UI renders, console is clean. Don't formalize assertions yet — this is reconnaissance that informs the spec you write in 2b.

The CLI is **stateful** — `open` starts a browser session, subsequent commands act on it. Use a named session (`-s=vf`) so other parallel sessions don't collide. Reference: https://github.com/microsoft/playwright-cli.

```bash
SESSION=vf

# Open the feature route. -s names the session so we can target it across commands.
playwright-cli -s=$SESSION open "http://localhost:<port><route>"

# Capture a DOM snapshot — gives you element refs you can use in subsequent commands.
playwright-cli -s=$SESSION snapshot > .verify/snapshot.txt

# Drive the feature (examples — adapt to what the description says):
#   playwright-cli -s=$SESSION click "getByRole('button', { name: 'Save' })"
#   playwright-cli -s=$SESSION fill   "getByLabel('Email')" "test@example.com"
#   playwright-cli -s=$SESSION press  Enter
# Use `snapshot` between actions to confirm state changed.

# Save evidence.
playwright-cli -s=$SESSION screenshot --filename=.verify/smoke.png

# Inspect network + console for problems before declaring smoke green.
playwright-cli -s=$SESSION requests       > .verify/requests.txt   # network log
playwright-cli -s=$SESSION eval "() => ({title: document.title, url: location.href})"

# Close the session.
playwright-cli -s=$SESSION close
```

**If `--use-mcp`:** the Playwright MCP tools (`mcp__plugin_playwright_playwright__*`) are acceptable here as an alternative driver for the same actions (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_take_screenshot`). Save the screenshot to `.verify/smoke.png`. Don't switch to MCP or `@playwright/cli` for 2b — durable specs always go through `@playwright/test`.

**Smoke check passes if:**
- The first response status is < 400 (check via the `requests` listing or by inspecting the snapshot for an error page).
- Page title is non-empty.
- The feature-specific elements named in `$ARGUMENTS` appear in the snapshot.
- No JavaScript errors thrown during navigation/interaction.

If smoke fails, STOP before writing a spec — fix the app first. Leave the dev server running so the user can inspect.

**→ TaskUpdate:** Mark "Stage 2a: Smoke check" as `completed`.

### Stage 2b — Author/update the e2e spec (only if e2e is configured)

**→ TaskUpdate:** Mark "Stage 2b: Author/update e2e spec" as `in_progress`.

**Skip this entire sub-stage if e2e was not detected in auto-detection step 6, or if `--no-e2e` was passed.** Never scaffold an e2e setup — if the project doesn't have one, the smoke check in 2a is the verification and Stage 2c also skips.

When e2e IS configured: place the spec in the existing e2e directory using the project's conventions (file naming, fixtures, helpers). Match what's already there — don't introduce a new style. Look at 1-2 neighboring specs before writing yours so the helpers/fixtures/imports match.

JS/TS template (adapt to repo conventions — copy patterns from neighboring specs first):

```ts
// e2e/tests/<feature>.spec.ts
import { test, expect } from "@playwright/test";

test.describe("<feature name from $ARGUMENTS>", () => {
  test("renders and behaves correctly", async ({ page }) => {
    await page.goto("<route>");
    await expect(page).toHaveTitle(/<expected>/);
    await expect(page.getByRole("heading", { name: /<heading>/i })).toBeVisible();

    // Interaction
    await page.getByRole("button", { name: /<cta>/i }).click();
    await expect(page).toHaveURL(/<post-action-route>/);

    // Async side effect (if Stage 1b worker is involved):
    // poll an API endpoint or UI state for up to ~30s
    await expect(async () => {
      const r = await page.request.get("/api/<resource>");
      expect(r.ok()).toBeTruthy();
      expect((await r.json()).status).toBe("completed");
    }).toPass({ timeout: 30_000 });
  });

  test("no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("<route>");
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
});
```

**.NET template** (NUnit + `Microsoft.Playwright.NUnit`): place under the existing `*.E2E.Tests` project, follow neighbor `[Test]` classes.

**Python template** (`pytest-playwright`): place under `tests/e2e/`, use `def test_<feature>(page):` style.

If a spec for this feature already exists, EXTEND it rather than creating a duplicate. Stage the new/modified spec for commit.

**→ TaskUpdate:** Mark "Stage 2b: Author/update e2e spec" as `completed`.

### Stage 2c — Run just this spec (only if e2e is configured)

**→ TaskUpdate:** Mark "Stage 2c: Run e2e spec" as `in_progress`.

Skip if e2e was not detected or `--no-e2e` was passed. Run **only the new/modified spec** for fast feedback (the full suite runs in Stage 4):

| Stack | Command |
|-------|---------|
| JS/TS | `npx playwright test <path-to-spec>` (or `<pm> exec playwright test ...` if `e2e/` is its own workspace) |
| .NET | `dotnet test <E2E-project> --filter "FullyQualifiedName~<TestClass>"` |
| Python | `pytest <path-to-spec> -v` |

Pass `--reporter=list` (JS/TS) for readable output.

**Pass criteria:**
- The new spec exits green.
- Browser console asserted clean (covered by the spec's "no console errors" case).
- If Stage 1b started a worker: the spec's async side-effect assertion passed, proving the job actually ran. Additionally verify by tail-checking `.verify/worker.log` for a success line for the job and no `exception`/`failed`/`error` lines.

**Capture artifacts:**
- Copy the Playwright HTML report (e.g. `e2e/playwright-report/`) summary line and `test-results/` traces into `.verify/` for the PR.
- Copy the final passing screenshot from `test-results/.../*.png` to `.verify/screenshot.png`.

On any failure in 2a/2b/2c: STOP. Leave the server (and worker) running so the user can inspect. Report what failed and where.

**→ TaskUpdate:** Mark "Stage 2c: Run e2e spec" as `completed`.

## Stage 3 — Stop Server (and Worker)

**→ TaskUpdate:** Mark "Stage 3: Stop server and worker" as `in_progress`.

1. If `.verify/worker.pid` exists, kill it: `kill -9 $(cat .verify/worker.pid) 2>/dev/null || true`. Stop the worker BEFORE the web server so any final task completion writes flush cleanly.
2. If `.verify/server.pid` exists, kill it: `kill -9 $(cat .verify/server.pid) 2>/dev/null || true`.
3. Free the web port: `lsof -ti tcp:<port> | xargs -r kill -9`.

This is required before Stage 4 — running builds while the dev server or worker hold file locks (especially with `dotnet watch`, `nodemon`, or `uvicorn --reload`) breaks the build.

**→ TaskUpdate:** Mark "Stage 3: Stop server and worker" as `completed`.

## Stage 4 — Local CI

**→ TaskUpdate:** Mark "Stage 4: Local CI" as `in_progress`.

Run the detected commands **in order**. Stop on first failure.

| Step | JS/TS | Python | .NET |
|------|-------|--------|------|
| Lint / format | `<pm> run lint` | `ruff check` + `ruff format --check` | `dotnet format --verify-no-changes` |
| Typecheck | `<pm> run typecheck` / `tsc --noEmit` | `mypy` / `pyright` (if configured) | covered by `dotnet build` analyzers |
| Unit tests | `<pm> test` | `pytest` (via `uv run` / `poetry run` if applicable) | `dotnet test --nologo` |
| Build | `<pm> run build` | skip for apps; `python -m build` for libs | `dotnet build -warnaserror --nologo` |
| **Full e2e suite** *(skip if not configured)* | `npx playwright test` (or `<pm> --prefix e2e test`) | `pytest tests/e2e/` | `dotnet test <E2E-project> --nologo` |

**Full e2e suite — only if an e2e setup was detected in auto-detection step 6 AND `--no-e2e` was not passed.** Otherwise skip silently and mark this row `— (no e2e)` in the results table. Never create an e2e setup as a side effect of /vf.

When e2e IS configured: it needs the app running again. Unit tests don't need the dev server, but the e2e suite does. Order:
1. Run lint + typecheck + unit tests + build (parallel where safe). Stop on first failure.
2. Restart the app (and worker if Stage 1b ran). Builds may have cleared `dist/`, killed file watchers, etc.
3. Wait for health, then run the **full e2e suite** (not just the new spec — that ran in Stage 2c).
4. Stop the app + worker again.

If the e2e suite has a "smoke" subset (e.g. `npm run test:e2e:smoke`, `pytest -m smoke`), prefer running smoke first as a quick gate, then full. Surface flaky-test retries in the summary table.

Display a results table at the end:

```
Stage           Status
-----           ------
Lint            ✓
Typecheck       ✓
Unit tests      ✓
Build           ✓
```

If any step fails, stop, surface the failing output, and do NOT proceed to Stage 5.

**→ TaskUpdate:** Mark "Stage 4: Local CI" as `completed`.

## Stage 5 — Open PR

Skip if `--no-pr` is set.

**→ TaskUpdate:** Mark "Stage 5: Open PR" as `in_progress`.

1. If `.verify/screenshot.png` exists:
   - `git add .verify/screenshot.png` and commit with subject `chore: add verification screenshot`.
2. **If `--qa-passed`:** also stage QA artifacts for the PR:
   - `git add .qa/reports/qa-report-iteration-*.md` — the QA reports
   - `git add .qa/screenshots/iteration-$(cat .qa/current-iteration)/00-initial-state.png` — final QA screenshot
   - Commit with subject `chore: add QA report and evidence`
3. Push the branch: `git push -u origin HEAD`. **Never** `--force` or `--force-with-lease` here.
4. Construct the raw screenshot URL from the remote (e.g. `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/.verify/screenshot.png`).
5. Create the PR:
   ```bash
   gh pr create --base <base> --title "<short title>" --body "$(cat <<'EOF'
   ## Summary
   <1–3 bullets describing the change, derived from commits + feature description>

   ## Verification
   - Browser-verified at `<route>` on port `<port>`
   - Console: no errors
   - Local CI: lint / typecheck / tests / build all green

   ![verification](<raw screenshot URL>)

   ## QA Report
   {IF --qa-passed: include this section, else omit}
   - Full QA cycle completed ({N} iterations)
   - {total_passed} tests passed, {total_failed} bugs found and fixed
   - Categories tested: Happy Path, Form Validation, Error States, Edge Cases{, Accessibility, Responsive, Performance if applicable}
   - See `.qa/reports/` for full reports

   ## Test plan
   - [ ] Reviewer loads `<route>` and confirms <key assertion>
   - [ ] CI is green
   EOF
   )"
   ```
6. Print the PR URL.

If `gh` is not authenticated, stop before pushing and tell the user to run `gh auth login`.

**→ TaskUpdate:** Mark "Stage 5: Open PR" as `completed`.

---

## Output Format

At the end (success or failure), print a compact summary:

```
/vf summary
  Branch:       <branch> → <base>
  Port / route: <port> <route>
  Worker:       <command or "not required">
  E2E suite:    <runner> · spec: <new-or-modified-spec>
  QA:           passed (3 iterations, 12 bugs found+fixed) | not run
  Stages:       0 ✓  1 ✓  1b ✓  2a ✓/⊘  2b ✓  2c ✓  3 ✓  4 ✓  5 ✓
  PR:           <url or "skipped">
  Artifacts:    .verify/smoke.png, .verify/screenshot.png, .verify/server.log,
                .verify/worker.log, .verify/playwright-report-summary.txt
                {if --qa-passed: .qa/reports/qa-report-iteration-*.md}
```

Use ⊘ for stages skipped due to `--qa-passed` (not a failure, just redundant). On failure, replace the failed stage's ✓ with ✗ and include a short reason on the next line.

## Cleanup

Always (success or failure):
- **Task list audit (MANDATORY):** Call `TaskList`. Mark any remaining `in_progress` or `pending` tasks as `completed` (if done) or update their description with the reason they were skipped. Every task must be in a terminal state before you finish.
- Close any open `@playwright/cli` session: `playwright-cli -s=vf close 2>/dev/null || true`.
- Kill the worker if it's still running (`.verify/worker.pid`).
- Kill the dev server if it's still running (`.verify/server.pid`).
- Leave `.verify/` in place — it's the audit trail. The user can `.gitignore` it if they don't want it tracked.

## Notes for the model running this command

- **Use TaskCreate/TaskUpdate for all stages** per the Task Tracking section — create the full task list before Stage 0 and update statuses as you go. Call TaskList before finishing to ensure no orphaned tasks.
- **Pass an explicit `timeout` on every Bash call.** Pick the value from the "Timeouts" table — never accept the default. A command without a timeout is a bug.
- Run independent checks in parallel where possible (e.g. lint + typecheck) using parallel Bash calls.
- Don't ask clarifying questions when reasonable defaults exist — echo detected values and proceed.
- If you genuinely cannot detect a required value (port, start command), ask the user **once** with a recommended default.
- Never invent or guess a PR URL. Only print what `gh pr create` actually returned.
