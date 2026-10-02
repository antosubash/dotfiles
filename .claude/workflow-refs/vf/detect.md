# /vf — Auto-detection details

Read by /vf before Stage 0 for any value not supplied by a flag. A repo can be polyglot — detect the stack matching the branch's changes, or ask if ambiguous. Run every step with the stack's runner (`uv run pytest`, `poetry run pytest`, `pnpm run lint`, ...) so deps resolve.

## 1. Stack, framework, start command, port

- **.NET** — `*.sln`, `*.csproj`, `global.json`, or `Program.cs`:
  - ASP.NET Core (Web API / Blazor / MVC). Port from `Properties/launchSettings.json` `applicationUrl` (commonly 5000/5001 or 5xxx); fall back to 5000.
  - Multi-project solutions: prefer the project with `Microsoft.NET.Sdk.Web` SDK and `OutputType=Exe`. If multiple, ask.
- **Python** — `pyproject.toml`, `requirements*.txt`, `manage.py`, or `setup.py`:
  - `manage.py` → Django (8000, `python manage.py runserver`)
  - `fastapi` / `uvicorn` in deps → FastAPI (8000, `uvicorn <module>:app --reload`)
  - `flask` in deps → Flask (5000, `flask --app <module> run --debug`)
  - Runner: prefer `uv run`, then `poetry run`, then `.venv/bin/python`, else system `python`.
- **JS/TS** — `package.json`:
  - `next` → 3000 (`<pm> run dev`); `vite` → 5173; `@remix-run/*` → 3000; `astro` → 4321; `nuxt` → 3000; `@sveltejs/kit` → 5173.
  - Package manager from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, else npm.

Port precedence: `--port`, else env (`PORT` / `ASPNETCORE_URLS` in `.env*` or `launchSettings.json`), else framework default. `--start` always overrides the start command.

## 2. CI commands (Stage 4)

- **.NET:** `dotnet format --verify-no-changes` (lint+format), `dotnet build -warnaserror --nologo` (build+analyzers = typecheck), `dotnet test --nologo`.
- **Python:** `ruff check` + `ruff format --check`, `mypy` or `pyright` if configured, `pytest`, `python -m build` only for a library — for apps skip build rather than invent one.
- **JS/TS:** `package.json` scripts `lint`, `typecheck`/`type-check`, `test`, `build`. Skip any that don't exist.

## 3. E2E setup (optional — never scaffold, never prompt to create)

Signals:
- `playwright.config.{ts,js,mjs}` at repo root, `e2e/`, `tests/e2e/`, or `apps/*/e2e/`.
- `.csproj` with `Microsoft.Playwright.NUnit` / `.MSTest` / `.Xunit` (typically `*.E2E.Tests`).
- `pytest-playwright` in `pyproject.toml` / `requirements*.txt`, tests under `tests/e2e/` or `test_*_e2e.py`.

If detected, capture:
- Full-suite command (e.g. `npm --prefix e2e test`, `dotnet test src/Acme.E2E.Tests`, `pytest tests/e2e/`) from `package.json` scripts, `.csproj` test ID, or pytest paths.
- The `baseURL` / env var the suite expects (Playwright `use.baseURL`, often env-overridable). The dev server URL must match — surface any mismatch.
- The spec naming convention (`<feature>.spec.ts`, `<Feature>Tests.cs`) for Stage 2b.

## 4. Background worker

Detection:
- **.NET:** project with `Microsoft.NET.Sdk.Worker` SDK, or a `BackgroundService` / `IHostedService` class in a separate `*.Worker` / `*.Jobs` project. Packages: `Hangfire.*`, `Quartz`, `MassTransit`, `Coravel`. Start: `dotnet run --project <Worker>` (or `dotnet watch run --project <Worker>`).
- **Python:** `celery` → `celery -A <app> worker -l info`; `rq` → `rq worker`; `dramatiq` → `dramatiq <module>`; `arq` → `arq <module>.WorkerSettings`; Django-Q → `python manage.py qcluster`. Wrap with `uv run` / `poetry run` if applicable.
- **JS/TS:** `package.json` scripts `worker`, `jobs`, `queue`, `worker:dev`. Packages: `bullmq`, `bull`, `bee-queue`, `agenda`, `inngest`. A `Procfile` `worker:` line is a strong signal.
- **Generic:** `Procfile` (Heroku/Foreman) non-web processes — start the relevant line.

Decision — start the worker only if at least one is true (`--no-worker` always wins: never start):
- The feature description mentions async / queue / email / notification / background / job / webhook / schedule.
- `git diff --name-only origin/<base>...HEAD` touches the worker project dir, `*tasks*`, `*jobs*`, `*queue*`, `*worker*`, `*BackgroundService*`, `*celery*`.
- Stage 2 browser interaction enqueues a job whose side effect must be asserted.
- `--with-worker` was passed.

Detected but not needed → echo `Worker: detected but not required for this feature (skipping). Pass --with-worker to force.`
