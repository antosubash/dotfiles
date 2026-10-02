---
description: Create or update the repo's `running-the-stack` skill — how to start, check and stop the app locally — so /qa, /vf, /ship, /feature and future sessions launch it without guessing or asking.
argument-hint: [--update] [--no-verify]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Monitor
---

# /runbook — Teach Claude how to run this repo

Writes `.claude/skills/running-the-stack/SKILL.md` in the current repo: the exact commands to start the app, how to know it's up, the ports and URLs, test logins, and the gotchas that cost time. Every later session (and `/qa`, `/vf`, `/ship`, `/feature`) uses it instead of rediscovering how to start the stack.

User invoked with: `$ARGUMENTS`

- `--update` — the skill exists; refresh it against the current repo (and this session's experience) instead of refusing.
- `--no-verify` — write it from reading the repo only; don't start the app to prove the commands work.

## Rules

- **Verified commands only.** Unless `--no-verify`, every launch command in the skill must have actually been run in this session and reached healthy. Mark anything unverified with `(unverified)`.
- **No secrets.** Never copy values from `.env*`, user-secrets, or credential files. Name the variable and where it comes from (e.g. "`STRIPE_SECRET_KEY` — from `.env.local`, ask the user").
- **Short.** Under ~80 lines. Link to longer docs in the repo instead of copying them.
- If the skill exists and `--update` isn't set, show what it says and stop.

## Steps

1. **Gather** — dispatch one `Explore` agent (`model: sonnet`) to collect: `README`, `CLAUDE.md`/`AGENTS.md` run sections, `package.json` scripts, `Makefile`/`justfile`/`Taskfile`, `docker-compose*.yml`, `Procfile`, Aspire AppHost, `pyproject.toml` scripts, `.env.example`, `launch.json`, CI workflow steps that start services, and e2e config (`playwright.config.*` `webServer`). Also use anything you learned starting the app earlier in this session — failures and their fixes are the most valuable part.
2. **Verify** (unless `--no-verify`) — start dependencies and the app in the background, wait with Monitor until the health URL responds (or it fails), check the main route, then stop everything you started. Fix-and-retry once on simple failures (missing install, wrong port); record each fix as a gotcha.
3. **Write** `.claude/skills/running-the-stack/SKILL.md`:

```markdown
---
name: running-the-stack
description: Use when launching, restarting, or smoke-testing <repo> locally — <main processes> — or when a local run fails to start, a port is taken, or login fails.
---

# Running <repo>

## Prerequisites (once per machine)
- <runtimes + versions, shared infra (e.g. ~/Repos/dev-services `make up`), env file setup>

## Launch
| Scenario | Command |
|---|---|
| Full stack | `…` |
| Frontend / backend only | `…` |
| Background worker | `…` |
| Migrations / seed | `…` |

## Ready check
- Health: `curl -fsS http://localhost:<port>/<health>` → <expected>
- App URL: `http://localhost:<port><main route>`  ·  Test login: <how to get one, no secrets>

## Stop / reset
- `…` (and which ports to free)

## Gotchas
- <each failure hit and its fix>

## Tests
- Unit: `…`  ·  E2E: `…`
```

4. **Commit** it on the current branch (`docs: add running-the-stack skill`) if the tree was otherwise clean; otherwise leave it staged and say so. Never commit on `main`/`master` — if on the base branch, leave it uncommitted and say so.
5. **Report** the path, which commands were verified, and any `(unverified)` lines.
