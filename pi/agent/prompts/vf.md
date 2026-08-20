---
description: Run a gated branch verification pipeline and optionally open one pull request
argument-hint: "[feature] [--port N] [--route PATH] [--start CMD] [--health URL] [--base BRANCH] [--run-id ID] [--no-pr] [--no-rebase] [--skip-browser] [--no-smoke] [--no-e2e] [--e2e-only PATH] [--qa-passed] [--qa-run-id ID]"
---

# Pi verify-feature workflow

Verify `$ARGUMENTS` with a gated pipeline. Any failed stage stops later stages and prevents PR creation.

## Inputs

Parse feature text and flags: `--port`, `--route`, `--start`, `--health`, `--base`, `--run-id`, `--no-pr`, `--no-rebase`, `--skip-browser`, `--no-smoke`, `--no-e2e`, `--e2e-only`, `--qa-passed`, `--qa-run-id`, `--with-worker`, `--no-worker`, and `--worker`.

Auto-detect the affected stack (JS/TS, Python, or .NET), package runner, start command, port, base branch, lint/format, typecheck, tests, build, existing e2e setup, and optional background worker. Read project instructions first. Ask once only when a required value cannot be inferred. Echo the detected plan.

When `--run-id` or `--qa-run-id` is supplied, validate it before resolving any run or QA path: require 1–64 lowercase slug characters matching `^[a-z0-9]+(-[a-z0-9]+)*$`; reject invalid values rather than sanitizing or interpolating them. `--qa-passed` requires an explicit `--qa-run-id`; reject the combination when it is absent. Never resolve `latest-run` for a passed-QA gate.

## Safety and evidence

- Refuse to run on the base branch.
- Never force-push, bypass hooks, auto-resolve rebase conflicts, read/commit secrets, or commit evidence.
- Keep logs/screenshots/reports under the unique claimed `VF_DIR="$(git rev-parse --absolute-git-dir)/pi-verify/$VF_RUN_ID"`; never use the shared `pi-verify` directory as a run directory.
- Use explicit tool timeouts: 10–15s inspection, 60s git network/PR, 180s lint/typecheck, 300s test/build/spec, 600s full e2e.
- Persist `$VF_DIR/state.json` at every stage and print a short stage status line.
- Always clean up owned browser sessions, server, and worker on success or failure.

## Stage 0 — prepare branch

1. Resolve branch/base and atomically claim a unique run directory before creating state, reports, sessions, or PIDs:

   ```bash
   GIT_DIR="$(git rev-parse --absolute-git-dir)"
   VF_BASE="$GIT_DIR/pi-verify"
   VF_RUN_ID="<explicit --run-id or vf-<branch-slug>-YYYYmmdd-HHMMSS-$$>"
   # Validate explicit IDs before interpolation: ^[a-z0-9]+(-[a-z0-9]+)*$, 1–64 chars.
   VF_DIR="$VF_BASE/$VF_RUN_ID"
   mkdir -p "$VF_BASE"
   if ! mkdir "$VF_DIR"; then
       printf 'Refusing existing verify run %s at %s. Choose a new --run-id; inspect owner/PIDs before removing a stale run.\n' "$VF_RUN_ID" "$VF_DIR" >&2
       exit 2
   fi
   printf '%s\n' "pid=$$" > "$VF_DIR/owner"
   vf_cleanup_notice() { printf 'Verify run %s stopped; inspect %s and owned PIDs before cleanup.\n' "$VF_RUN_ID" "$VF_DIR" >&2; }
   trap vf_cleanup_notice EXIT
   ```

   Store the exact `VF_RUN_ID`, absolute `VF_DIR`, state path, report path, browser session names, server/worker PID paths, and QA run ID in state. A failed claim must not create or reuse any artifact from that ID.
2. Check required tools: git; `gh auth status` when opening a PR; `playwright-cli --help` and `playwright-cli install-browser chromium` when browser verification runs.
3. Inspect status. If task-related changes are pending, refuse secret-like paths, stage only intended files, review staged diff, and commit with a concise repository-consistent message. Persist the exact state path under this run's `VF_DIR`.
4. Unless `--no-rebase`, fetch and rebase onto `origin/<base>`. On conflict, abort and stop.

## Stage 1 — start application and optional worker

Skip the app for `--skip-browser`. Otherwise, before starting anything, inspect the target port with an OS-appropriate listener check (`lsof`/`ss`/`netstat`) and refuse immediately when it is occupied. Do not kill, adopt, or accept another service; if port ownership cannot be established, stop. Start only the requested command with output and PID under this run's `VF_DIR`. Poll for up to 90 seconds, accepting 200/302/401 only while the workflow-owned root PID is alive and its required process tree remains alive. Health alone is insufficient: if the owned PID/tree exits, fails, or changes ownership, stop and preserve logs. Record the exact PID and process-tree check result in state.

Start a detected worker only when the feature or changed files require it, or `--with-worker` is supplied; never when `--no-worker` is supplied. Check its queue backend first, log output/PID, and require a ready signal or healthy live process without fatal logs.

## Stage 2a — browser smoke

Skip for `--skip-browser`, `--no-smoke`, or `--qa-passed`.

Use the `playwright-cli` skill and the unique claimed-run session `-s=vf-${VF_RUN_ID}-smoke`; persist that exact session name under `VF_DIR` and always close it in final cleanup:

1. Open the exact feature URL and snapshot to `$VF_DIR/snapshot.txt`.
2. Verify non-error response, non-empty title, feature-specific elements, and at least one key interaction.
3. Inspect `console error` and `requests`.
4. Save `$VF_DIR/smoke.png` and close the session.

Stop on failure before writing e2e tests.

When `--qa-passed`, use only the explicitly validated `--qa-run-id`: `QA_DIR="$(git rev-parse --absolute-git-dir)/pi-qa/$QA_RUN_ID"`. Require that exact directory's `result.json` status `clean`; copy final screenshots and retain the exact QA run ID, absolute QA directory, result path, counts, and report path in this run's state/report. A missing or non-clean QA result is a gate failure. There is no latest-run fallback.

## Stage 2b/2c — durable e2e test

Skip gracefully when no e2e configuration exists or `--no-e2e` is supplied; never scaffold a new framework.

When configured, inspect neighboring tests and add or extend one spec for the feature using existing fixtures/conventions. Include the key flow and console/page-error assertion. Run only that spec first (`--e2e-only` overrides selection). Stop if it fails. Keep source test changes; copy runtime traces/screenshots to VF_DIR rather than committing them.

## Stage 3 — stop runtime

Stop the owned worker, then owned web server, gracefully first. Ensure the web port is released before build commands to avoid watcher/file-lock failures.

## Stage 4 — local CI

Run independent lint/format, typecheck, and unit-test commands in parallel when safe, then build. For .NET, avoid racing commands that share `obj/bin`; run format and tests safely and build sequentially with analyzers. If e2e exists, repeat the occupied-port refusal and owned PID/process-tree-plus-health checks before restarting any required service, run the full suite, and stop services again.

Record every command and result in state. Any failure stops before push/PR.

## Stage 5 — report, push, and PR

Build `$VF_DIR/report.html` as a self-contained local report with stage results, screenshots, e2e outcome, and QA report link/counts when applicable. Use a script for image base64; do not stream encoded images through model tools.

If `--no-pr`, finish with a verify-only summary. Otherwise the standalone `/pr` race-safe lock/invariant procedure applies; pass the exact `VF_DIR` report path and run ID to it:

1. Recheck `gh auth status`, branch status, and clean intended diff.
2. Push with `git push -u origin HEAD`—never force.
3. Create exactly one PR with `gh pr create --base <base>`. Include summary, validation commands/results, browser route, local report path, QA counts/report path, and reviewer test plan.
4. Print only the URL returned by `gh`; never invent one.

## Final output and cleanup

Print branch/base, exact `VF_RUN_ID`, port/route, worker decision, e2e runner/spec, QA status and exact QA run ID/path, per-stage status, PR URL or skipped, report path, and `VF_DIR`. On failure identify the exact gate and preserve logs. Always close only this run's named Playwright sessions and stop only its owned PIDs/tree; leave `VF_DIR` as the audit trail.
