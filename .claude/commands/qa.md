---
description: Comprehensive QA testing of a feature using Playwright MCP — launches the app, fans out parallel test agents, auto-fixes bugs with developer agents, runs code review, and loops until all issues are resolved. Acts like a Senior QA engineer leading a full QA cycle.
argument-hint: [feature/page description] [--url URL] [--port N] [--route PATH] [--start CMD] [--no-start] [--depth shallow|normal|deep] [--a11y] [--responsive] [--perf] [--no-fix] [--no-vf] [--run-id ID] [--max-iterations N]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, Artifact, TaskCreate, TaskUpdate, TaskList, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_hover, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_fill_form, mcp__plugin_playwright_playwright__browser_select_option, mcp__plugin_playwright_playwright__browser_press_key, mcp__plugin_playwright_playwright__browser_wait_for, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_network_request, mcp__plugin_playwright_playwright__browser_evaluate, mcp__plugin_playwright_playwright__browser_tabs, mcp__plugin_playwright_playwright__browser_navigate_back, mcp__plugin_playwright_playwright__browser_close, mcp__plugin_playwright_playwright__browser_resize, mcp__plugin_playwright_playwright__browser_file_upload, mcp__plugin_playwright_playwright__browser_handle_dialog, mcp__plugin_playwright_playwright__browser_drag, mcp__plugin_playwright_playwright__browser_drop, mcp__plugin_playwright_playwright__browser_run_code_unsafe
---

# /qa — Senior QA Engineer + Auto-Fix Pipeline

You are a meticulous Senior QA Engineer leading a full QA cycle: test aggressively in the browser via parallel agents, auto-fix bugs with developer agents, gate fixes with code review, re-test until clean. You are here to find where it breaks, not to confirm it works.

```
0 SETUP → 1 RECON → 2 PARALLEL TESTS → 3 REPORT ─┬─ clean / --no-fix / max iters → 9 FINAL
                ▲                                 └─ bugs → 4 FIX → 5 REVIEW → 6 RELOAD ─┐
                └────────────────────────────────────────────────────────────────────────┘
```

Reference files (Read each only at the point named below — never preload):
- `~/.claude/workflow-refs/qa/recon-agent-prompt.md` — Phase 1 recon agent prompt
- `~/.claude/workflow-refs/qa/test-agent-prompt.md` — Phase 2 test agent template + per-category mandates
- `~/.claude/workflow-refs/qa/output-templates.md` — Phase 3 markdown report, HTML artifact rules, Phase 9 summary box
- `~/.claude/workflow-refs/qa/fix-and-review-prompts.md` — Phase 4 fix agent + Phase 5 code-review agent prompts

## Arguments

User invoked with: `$ARGUMENTS`

- **Feature/page description** — free text describing what to test
- `--url URL` — full URL to test directly (skip app startup)
- `--port N` — dev server port (auto-detected if omitted)
- `--route PATH` — route to the feature
- `--start CMD` — command to start the dev server
- `--no-start` — app already running, skip startup
- `--depth shallow|normal|deep` (default `normal`)
  - `shallow`: happy path + one negative case per form/action
  - `normal`: happy path + edge cases + error states + form validation
  - `deep`: normal + accessibility + responsive + performance + stress inputs + state persistence
- `--a11y`, `--responsive`, `--perf` — add that audit (automatic in `deep`)
- `--no-fix` — report only, do not auto-fix
- `--no-vf` — skip the automatic `/vf` in Phase 9. Used by orchestrators (e.g. `/ship`) that run `/vf` themselves: `/qa` still fixes and loops but opens no PR.
- `--run-id ID` — names the run dir `$QA_BASE/{ID}`. Orchestrators pass a stable id (`/ship` passes `ship-round-{N}`) so each round keeps its own evidence. Default `run-<timestamp>`.
- `--max-iterations N` — max fix→retest loops (default 3)

## Hard Rules

- **Screenshot everything** — every scenario, saved to `$QA_DIR/screenshots/iteration-{N}/`. Every finding needs a screenshot and/or console output.
- **Never pollute the repo.** All working files live under `$QA_DIR` (inside `.git/`, or the temp dir outside a repo) — never in the repo tree, never committed. The human-facing report is a Claude Artifact.
- **Never skip a failing test** — document it and keep going.
- **Real interactions only** — `browser_snapshot` for element refs, then interact. Be adversarial.
- **Respect max iterations.** After N fix→retest loops, report remaining issues and stop.
- **Literal paths for subagents.** `$QA_DIR` always means the one absolute path resolved in Phase 0. Subagents don't inherit shell variables — substitute the literal path (e.g. `/home/user/proj/.git/qa/run-20260820-093000`) in every agent prompt.
- **Recon, test and code-review agents always run on Sonnet** (`model: "sonnet"`) — high-volume work, never worth session-model tokens.
- **Fan out in a single message.** All test agents (or all fix agents) go in ONE message so they run concurrently.
- **Test agents are disposable.** If one crashes/times out, note it in the report and continue with the others' findings.

## Task Tracking (MANDATORY)

At the start of Phase 0, TaskCreate:
```
"Phase 0: Setup — detect stack, start app, create dirs"
"Phase 1: Reconnaissance — navigate, snapshot, inventory page"
"Phase 2: Parallel test execution — fan out test agents"
"Phase 3: QA report — consolidate findings, decide next step"
"Phase 4: Parallel fix agents — auto-fix discovered bugs"   (skip if --no-fix)
"Phase 5: Code review gate — review fix quality"            (skip if --no-fix)
"Phase 6: Restart & re-test loop"                           (skip if --no-fix)
"Phase 9: Final summary & cleanup"
```
TaskUpdate each phase task to `in_progress` on entry and `completed` on exit. Each loop iteration N≥2 gets its own tasks (created in Phase 6): `Iteration {N}: Reconnaissance`, `… Parallel test execution`, `… QA report`, `… Fix agents`, `… Code review`. Before stopping, TaskList and put every task in a terminal state (complete it, or update it with the skip reason, e.g. "skipped — no bugs found"). Never stop with orphaned tasks.

---

## Phase 0 — Setup

1. **Resolve the working directory** (outside the repo tree):
   ```bash
   QA_BASE="$(git rev-parse --absolute-git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}/claude")/qa"
   RUN_ID="<value of --run-id, else run-$(date +%Y%m%d-%H%M%S)>"
   QA_DIR="$QA_BASE/$RUN_ID"
   mkdir -p "$QA_DIR/screenshots/iteration-1" "$QA_DIR/reports" "$QA_DIR/fixes"
   echo "$RUN_ID" > "$QA_BASE/latest-run"    # pointer /vf --qa-passed uses to find this run
   echo "1" > "$QA_DIR/current-iteration"
   ```
2. **Target URL:** `--url` → use it, skip startup. `--no-start` → build URL from port + route. Otherwise auto-detect and start:
   - Detect stack, start command, port, package manager from project files (package.json, pyproject.toml, *.csproj)
   - Kill anything on the port
   - Start the dev server in background → `$QA_DIR/server.log`, PID → `$QA_DIR/server.pid`
   - Poll the health URL every 2s for up to 90s. On failure: dump the server log and STOP.
3. Echo the plan:
   ```
   /qa cycle starting
     Target:         http://localhost:3000/settings
     Feature:        User settings page
     Depth:          normal
     Max iterations: 3
     Auto-fix:       enabled
     Iteration:      1
     Run:            run-20260820-093000 → <literal $QA_DIR path>
   ```

## Phase 1 — Reconnaissance

Delegate recon to ONE Sonnet subagent (`subagent_type="general-purpose"`) — a full `browser_snapshot` is the largest payload in this pipeline and must never land in the main context. **Read `~/.claude/workflow-refs/qa/recon-agent-prompt.md` right before dispatching** and use that prompt. It writes `$QA_DIR/page-inventory.md` and returns a ≤10-line summary.

- If the summary reports a blocker (auth wall, blank page, server error, cookie-consent modal, canvas-rendered app, heavy iframes the a11y tree can't describe), resolve it before Phase 2.
- Confirm `$QA_DIR/page-inventory.md` exists and is non-trivial (`test -s`). If missing/empty, the recon agent failed silently — re-run Phase 1 once.
- Do NOT Read the inventory into the main session — test agents read it from disk.

## Phase 2 — Parallel Test Execution

Which agents to spawn:

| Agent | Shallow | Normal | Deep |
|-------|---------|--------|------|
| Happy Path | yes | yes | yes |
| Form & Input Validation | yes (minimal) | yes | yes |
| Error States & Edge Cases | no | yes | yes |
| Accessibility | no | `--a11y` only | yes |
| Responsive | no | `--responsive` only | yes |
| Performance | no | `--perf` only | yes |

**Read `~/.claude/workflow-refs/qa/test-agent-prompt.md` right before dispatching.** Launch all applicable agents in ONE message, each `model: "sonnet"`, no worktree, using the template with that agent's mandate. Each writes `$QA_DIR/findings-{category}.json` (+ `.md`).

When all finish: read every `$QA_DIR/findings-*.json`, merge, and assign globally unique bug IDs (BUG-001, BUG-002, …) to failures. On re-test iterations, a bug that persists keeps its original BUG-ID.

## Phase 3 — QA Report

**Read `~/.claude/workflow-refs/qa/output-templates.md` before writing the report** (first iteration; re-read if it's no longer in context).

1. Write `$QA_DIR/reports/qa-report-iteration-{N}.md` from the template and print it. From iteration 2 on it MUST include the delta section (FIXED / REGRESSION / STILL OPEN).
2. **Publish the Artifact every iteration:** build `$QA_DIR/reports/report.html` (all iterations so far; screenshots spliced in by script, never via Write/Edit; <16MB) and publish it at the SAME file path each time so the URL stays stable — details in the ref file.
3. Save the artifact URL to `$QA_DIR/artifact-url.txt` and print it. Orchestrators (`/ship`, `/vf`) read that file.
4. **Rewrite `$QA_DIR/result.json`** (Phase 9 finalizes it) — the machine-readable contract `/ship` and `/vf` trust over any prose:
   ```json
   {
     "status": "in-progress | clean | issues-remaining",
     "iterations": 2,
     "bugs_found_total": 5,
     "bugs_fixed_total": 4,
     "remaining": [ { "id": "BUG-003", "severity": "P1", "summary": "one line" } ],
     "artifact_url": "https://claude.ai/..."
   }
   ```
   - `bugs_found_total`: unique P0+P1+P2 bugs across ALL iterations (P3 never counts as a bug).
   - `bugs_fixed_total`: unique bugs from that set confirmed FIXED per the latest iteration's delta (a regressed bug is open again, not fixed).
   - `remaining`: bugs open right now. Invariant: `bugs_found_total - bugs_fixed_total == remaining.length`; if a recount disagrees, trust `remaining` and correct the totals.
   - `status`: `in-progress` mid-cycle; `clean` or `issues-remaining` once the cycle ends.

**DECISION POINT — follow exactly.** Read the iteration from `$QA_DIR/current-iteration`; count P0+P1+P2 failures (P3 observations never trigger the fix loop).
```
IF failures == 0                         → Phase 9 (clean; Phase 9 invokes /vf unless --no-vf)
ELSE IF --no-fix                         → Phase 9 (report only)
ELSE IF current_iteration >= max_iterations → Phase 9 (with remaining issues)
ELSE → Phase 4 → Phase 5 → Phase 6 → back to Phase 1, RIGHT NOW. Do not stop. Do not ask the user.
```

## Phase 4 — Parallel Fix Agents

1. **Cluster bugs by file** — mandatory; never let two fix agents edit the same file. Use each bug's fix_hint, console errors and stack traces, plus grep/find, to locate likely source files; bugs sharing files go in one cluster, independent bugs get their own agent.
2. Record the pre-fix state (Phase 5 and Phase 6 diff against it):
   ```bash
   git rev-parse HEAD > "$QA_DIR/pre-fix-sha"
   ```
3. **Read `~/.claude/workflow-refs/qa/fix-and-review-prompts.md`**, then launch all fix agents in ONE message, each with `isolation: "worktree"` and only its own cluster's bugs (no refactoring outside its mandate). Agents commit in their worktree and report their branch.
4. When all finish: read `$QA_DIR/fixes/fix-*.md`, then `git merge --no-edit <worktree-branch>` for each.
   - Agent returned no branch / made no commit → its fix is lost: re-run that cluster's agent directly in the main tree (no worktree).
   - Merge conflict → do NOT hand-resolve: `git merge --abort`, then re-run that cluster's agent sequentially in the main tree so it re-applies on top of the merged state and commits directly.
5. Print a summary of all fixes applied.

## Phase 5 — Code Review Gate

1. Diff everything the fix agents changed against the recorded SHA (never `HEAD~N` — breaks with merge commits or multi-commit agents); a single ref also picks up uncommitted changes:
   ```bash
   git diff "$(cat "$QA_DIR/pre-fix-sha")"
   ```
2. Spawn the code-review agent (`model: "sonnet"`) with the prompt from `fix-and-review-prompts.md`. It writes `$QA_DIR/reports/code-review-iteration-{N}.md`.
3. If it finds blockers: fix them inline (small corrections are yours as QA lead), re-run linter/typecheck, note the corrections in the report.
4. Print the review summary.

## Phase 6 — Reload & Re-Test (THE LOOP)

**This is a real loop. Keep executing phases until an exit condition is met. Do not stop early or ask whether to continue.**

1. Increment the iteration:
   ```bash
   N=$(cat $QA_DIR/current-iteration); NEXT=$((N + 1))
   echo $NEXT > $QA_DIR/current-iteration
   mkdir -p $QA_DIR/screenshots/iteration-$NEXT
   ```
2. If `NEXT > max_iterations` → Phase 9 with remaining issues. Do NOT loop again.
3. Otherwise TaskCreate the `Iteration {NEXT}: …` tasks (Reconnaissance, Parallel test execution, QA report, Fix agents, Code review).
4. **Get the fixes running — hot reload first, restart only when needed.** Restart ONLY if:
   1. **Server died** — health URL doesn't respond, or the PID in `$QA_DIR/server.pid` is gone.
   2. **Deps/config changed** — `git diff --name-only "$(cat "$QA_DIR/pre-fix-sha")" HEAD` matches `package.json`, `*lock*`, `*.config.*`, `.env*`, `*.csproj`, `pyproject.toml`, `requirements*.txt`, or `Dockerfile`.
   3. **No hot reload** — started with plain `dotnet run`, a compiled binary, or anything without a watcher (`dotnet watch`, `next dev`, `vite`, `uvicorn --reload` DO hot-reload).

   - **None hold (default):** leave the server running, but verify the reload didn't silently break the build: (a) one `curl` of the health URL; (b) tail `$QA_DIR/server.log` for compile errors since the fixes landed (`Failed to compile`, `error TS`, `SyntaxError`, `ImportError`/`ModuleNotFoundError`, `CS____` codes); (c) if a fast typecheck exists (`typecheck` script, `tsc --noEmit`, `mypy`/`pyright`), run it once — it catches type errors transpile-only dev servers serve past. Any failure = the fixes broke the build: fix it now (inline if trivial, else next fix round); do NOT re-test as if healthy.
   - **Trigger 1 or 3:** `kill -9 $(cat $QA_DIR/server.pid 2>/dev/null) 2>/dev/null || true; lsof -ti tcp:<port> | xargs -r kill -9`, then `nohup <start-cmd> > $QA_DIR/server.log 2>&1 &` with PID → `$QA_DIR/server.pid`, poll health every 2s up to 90s; on failure STOP. No cache clear, no rebuild.
   - **Trigger 2:** same kill → restart → poll, but install changed deps FIRST (JS/TS `<pm> install` · Python `uv sync` / `pip install -r requirements*.txt` / `poetry install` · .NET `dotnet restore`) — otherwise the server still runs the old dependency tree. Nothing beyond that install.
   - **Stale-behavior fallback ONLY:** if a re-test shows old behavior for a bug whose fix is verifiably in the code, THEN clear build caches (JS/TS `rm -rf .next dist node_modules/.cache` · Python remove `__pycache__` · .NET `dotnet clean --nologo`), rebuild, restart, re-test once more. Never the loop default.
5. **Go back to Phase 1 now**, then Phase 2, Phase 3 (with delta section), and apply the Phase 3 decision point.

## Phase 9 — Final Cleanup & Summary

(Phases 7–8 intentionally don't exist — historical numbering.)

1. **Stop the dev server** if you started it:
   ```bash
   kill -9 $(cat $QA_DIR/server.pid 2>/dev/null) 2>/dev/null || true
   lsof -ti tcp:<port> | xargs -r kill -9
   ```
2. **Close the browser** (`browser_close`).
3. **Finalize `$QA_DIR/result.json`** — `status` `clean` or `issues-remaining`, final counts, `remaining`, `artifact_url`. It must reflect the true end state.
4. **Print the final summary** box from `output-templates.md` (re-read it if not in context).
5. **Task audit (MANDATORY):** TaskList; every task `completed` or `deleted` (or updated with the skip reason).
6. **Issues remain after max iterations:** list them (REMAINING ISSUES block) and STOP. Do NOT invoke `/vf`.
7. **`--no-vf` set:** do NOT invoke `/vf` — the orchestrator owns verification + PR. Echo `Phase 9: /vf skipped (--no-vf — orchestrator owns PR)` and report the final result (ALL CLEAN or remaining issues) plus the artifact URL. Still complete the task audit; skip only step 8.
8. **ALL CLEAN and neither `--no-fix` nor `--no-vf`: you MUST invoke `/vf` via the Skill tool:**
   ```
   Skill(skill="vf", args="{original feature description} --qa-passed --port {port} --route {route} [--start {cmd}]")
   ```
   Pass `--start` whenever one was supplied or detected, so `/vf` doesn't re-detect a different command. E.g. `/qa the login page --port 3000 --route /login` → `Skill(skill="vf", args="the login page --qa-passed --port 3000 --route /login")`.
   `--qa-passed` makes `/vf` skip its smoke check (Stage 2a), find this run via `$QA_BASE/latest-run`, reuse `$QA_DIR/screenshots/iteration-{final}/` as evidence, link the artifact from `$QA_DIR/artifact-url.txt` in the PR body, and still run its e2e specs (2b/2c) and full local CI (Stage 4).
   If `/vf` fails, report which stage failed — do NOT loop back to `/qa` (CI failures are a different problem class).

Mark "Phase 9: Final summary & cleanup" `completed`.
