# pi issue worker — shared app instance, cgroup process lifetime, push-first conflicts, project memory

Date: 2026-09-14

## Problem

A base-branch conflict retry on `IIASA.GeoWiki#501` takes 35–45 minutes and has failed twelve times
on verifier variance, never on the code. Measured from the one verifier run that passed (32.5 min):

| Phase | Time | Necessary |
|---|---|---|
| Agent resolves the conflicts, restores, runs repo checks | 2 min | yes |
| Implementer's own browser QA (launch, login, screenshots) | 6.5 min | duplicates the verifier's UI pass |
| Verifier: restore, install, Release build | 1.5 min | yes |
| Verifier: tests, Biome, type-check | 5 min | yes |
| Verifier: **eight** separate `launch → probe → stop` cycles of the Aspire stack | 11 min | no |
| Verifier: one launch whose readiness took 10 min | 10 min | no |
| Verifier: browser checks and screenshots | 1 min | yes |
| Verifier: reading launcher/e2e sources, `--help` on every tool | 4 min | no — rediscovery |
| Diff review, verdict, report | 2 min | yes |

The Aspire CLI log for the 10-minute launch shows every resource `Running` 18 s after start, then
silence, then a DCP keepalive failure. The kernel journal for that minute: `Under memory pressure`,
then an OOM kill with **155 `dotnet` processes (10.6 GB), 9 `dcp` orchestrators, 70 chrome (4.7 GB),
swap full**. Nine orchestrators means nine GeoWiki stacks were alive at once: the eight probe cycles
never tore anything down.

They leaked because of the harness's own rule. Each agent bash call runs in a process group; leftovers
are killed at the end of the call and the call is rejected ("bash command left background processes
running"). Agents learned `setsid ./scripts/start-apphost.sh`, which puts the stack in a new session the
harness cannot see. The rule meant to prevent leaks trains the agent to leak, and forces a relaunch for
every probe because nothing can survive a bash call.

Three more things cost every run: the verifier re-derives how to launch, what "ready" means and how to
log in (the `.pi-worker/qa.json` manifest declares them, but the harness only *tells* the agent); the
conflict flow pushes only after the whole QA gate, so a good resolution that dies late is lost and
the PR stays conflicted for another hour; and nothing learned in one run (a port quirk, a flaky test,
a launcher timing) survives into the next.

## Goals

- One app launch per job run, owned by the harness, shared by every stage that needs it.
- No process the agent starts can outlive the stage that started it, whatever it does.
- Conflict resolutions reach the PR as soon as they are resolved and checked; verification follows.
- The verifier verifies; it does not rediscover the repository or run its e2e suites.
- Findings persist per repository across runs, as advisory notes.
- A conflict retry in ~13 minutes instead of ~45, with the same or better evidence.

## Non-goals

- Re-enabling the OS sandbox (`PI_WORKER_SANDBOX=1`); this design works with it off and does not
  preclude it.
- Hot-reloading a running instance when the agent edits code (the instance is relaunched instead).
- A generic service orchestrator: the harness runs the repository's declared launcher, nothing more.
- Auto-fixing UI defects in the visual stage (unchanged: a defect there blocks the job as today).
- Repositories without a manifest: they keep today's behaviour end to end.

## Deliverables

| Area | Files | Purpose |
|---|---|---|
| App instance | `src/app-instance/{instance,endpoints,readiness,auth}.ts` (new, ≤300 lines each) | launch once, resolve endpoints, wait for readiness, run auth setup, expose, stop |
| Cgroup lifetime | `src/agent/cgroup.ts` (new), `src/agent/process-group.ts`, `systemd/*.service` | child cgroup per bash call and per instance; `cgroup.kill`; `Delegate=yes` |
| Flows | `src/worker/{conflict-flow,issue-flow,feedback-flow,evidence-flow}.ts`, `src/worker/app-stage.ts` (new) | push-first conflicts, stages share the instance, verifier evidence published |
| Prompts | `src/prompts/shared.ts`, `src/prompts/*.ts`, `src/qa-verification.ts` | "the app is running at…" section; no launching, no `setsid`, no e2e suites |
| Manifest | `src/qa-manifest.ts` | `readiness.endpoints` (static URLs) beside the Aspire form |
| Memory | `src/project-memory.ts` (new) | per-profile notes directory, prompt index, secret filter |
| Config | `src/config.ts`, `.env.example` | `PI_WORKER_APP_START_TIMEOUT`, `PI_WORKER_APP_MIN_AVAILABLE_MB` |
| Docs | `README.md`, `docs/troubleshooting.md` | manifest section, lifecycle, memory, symptoms |
| Tests | `test/app-instance.test.ts`, `test/cgroup.test.ts`, `test/project-memory.test.ts`, flow/prompt/manifest/config/systemd tests | see Testing |

## A. Harness-owned app instance

### When

A stage needs the instance when the manifest declares `launch` and the stage is a browser stage: the
implementer's visual QA, the independent QA verifier for a UI surface. "UI surface" is the one heuristic
the verifier already applies to the issue text and the changed/untracked paths; it moves to
`src/ui-surface.ts` so the stage wrapper and the verifier agree. The harness launches once
before the first such stage of a job run and stops after the last, in a `finally`. Without `launch` in
the manifest nothing changes: the agent launches as today.

### Start

`startAppInstance(config, worktree, manifest, { issueNumber, runId })`:

1. **Memory guard.** Read `MemAvailable` from `/proc/meminfo`; below
   `PI_WORKER_APP_MIN_AVAILABLE_MB` (default 4096) fail immediately with
   `App instance not started: 2311 MB available, 4096 MB required` — a clear block instead of ten
   minutes of swapping. The check is advisory on non-Linux (skipped).
2. **Launch.** Spawn `launch.argv` with `cwd = worktree`, `env = scrubbed process env + launch.env +
   PI_QA_RUN_ID`, stdout/stderr to `<dataDir>/instances/issue-<n>/<runId>/launch.log`, inside its own
   child cgroup (section B). The launcher stays in the foreground of that cgroup for the instance's life.
3. **Endpoints.** Resolve `aspire.resources` (key → resource display name) through
   `aspire describe --apphost <apphost> --format Json --non-interactive` in the worktree, retried every
   5 s until every key in `readiness.resources` (default: all keys) has `state == "Running"` and a URL
   (first `urls[].url`). For `readiness.endpoints` (new, static `name → url`) no resolution is needed.
4. **Readiness.** For each `readiness.paths` entry, `GET <endpoint><path>` until the status is 2xx/3xx
   (self-signed dev certificates accepted for `localhost`), retried every 3 s. The whole of 2–4 is bounded
   by `PI_WORKER_APP_START_TIMEOUT` (default 900 s), and aborts at once if the launcher exits.
5. **Auth.** If `auth.setup` is declared: run its argv with `auth.setup.env` and, for each
   `envFromEndpoints` entry, the resolved URL, in the instance's cgroup, output to `auth-setup.log`.
   Then require `auth.storageState` (worktree-relative) to exist and copy it to
   `<instanceDir>/storage-state.json` (0600). The copy is what agents get. The repository must
   gitignore `auth.storageState`: the verifier's source fingerprint covers tracked and untracked files,
   so a state file that git would list invalidates every verdict — the instance's auth step rejects a path
   `git check-ignore` does not accept.
6. **Record.** Write `<instanceDir>/instance.json`: endpoints, storage-state path, launch time,
   readiness duration, source fingerprint at launch, cgroup path.

Any failure in 1–5 stops the instance and throws `AppInstanceError` whose message carries the phase
and the last 40 lines of the relevant log. The flows turn that into today's ⛔/BLOCKED with the exact
launch failure, which is the outcome the owner asked for when a backend cannot be started.

### Expose

Every agent run that has an instance receives, in its bash environment:

- `PI_QA_INSTANCE=<instanceDir>` and `PI_QA_ENDPOINT_<KEY>=<url>` for each resource key (upper-cased,
  non-alphanumerics → `_`), `PI_QA_STORAGE_STATE=<path>` when auth is declared;

and in its prompt, rendered by `qaManifestInstructions` in place of today's launch/readiness/auth
procedures:

> The application is already running for this run. Endpoints: frontend `http://localhost:3005`, api
> `https://localhost:44431`, …. A Playwright storage state for role `ContentEditor` is at `…`: load it
> (`playwright-cli state-load`) instead of driving the login form. Do not start, stop or relaunch the
> stack, do not run the launcher, do not use `setsid`/`nohup`; if the instance is unusable, report
> BLOCKED with the exact observation. Do not run the repository's Playwright e2e or post-deploy suites;
> check behaviour directly against this instance.

### Stale instance

The instance is bound to the source fingerprint taken at launch. Before each stage,
`instance.ensureCurrent()` re-fingerprints the worktree; a difference (the visual stage edited code)
stops and relaunches. The implementer's main run does not get an instance: it edits code, and the
instance would be stale before it was useful.

### Stop

`stop()`: `SIGTERM` to the launcher (so a launcher's own exit trap — GeoWiki drops its databases — runs
and Aspire stops its resources), wait up to 30 s, then `cgroup.kill` on the instance cgroup, wait for it
to empty, remove it. Runs in `finally` of the stage wrapper and on the worker's shutdown signal. On
worker start, any `qa-*` child cgroup left under the worker's cgroup by a crash is killed and removed.

### Stage wrapper

`src/worker/app-stage.ts`: `withAppInstance(ctx, worktree, job, needsInstance, fn)` — loads the
manifest, starts the instance when `needsInstance` and `launch` exist, passes `instance | null` to `fn`,
stops in `finally`. Flows call the visual stage and the verifier inside `fn`; both accept
`instance: AppInstance | null` and pass it to the prompt builders.

## B. Cgroup-scoped process lifetime

The worker runs as a systemd user service, so it owns a cgroup subtree. `src/agent/cgroup.ts`:

- `ownCgroup()` from `/proc/self/cgroup`; `available()` when that path exists under `/sys/fs/cgroup`
  and is writable (a cgroup v2 host running under systemd). Otherwise every function is a no-op and
  process groups keep working as today (development shells, macOS, tests without systemd).
- `createChild(name)` → `mkdir`, `adopt(pid)` → write to `cgroup.procs`, `killAndRemove()` →
  `cgroup.kill`, wait until `cgroup.procs` is empty (≤10 s), `rmdir`.

`createBashOperations` puts each bash call in `bash-<seq>`: the command is spawned through a shim,
`sh -c 'echo $$ > "$1/cgroup.procs" && exec bash -c "$2"' sh <cgroup> <command>`, so the shell moves
itself into the cgroup before `exec` and every descendant inherits it — no window in which an early fork
escapes. The policy still inspects the unwrapped command text. At the end of the call, if the cgroup
still holds processes: `killAndRemove()`, then the existing rejection message. `setsid`, `nohup`,
double forks and DCP-spawned children are all inside the cgroup, so none survive. The process-group
kill remains as the fallback path and for the timeout/abort cases.

Both units gain `Delegate=yes`, the correct declaration for a service that manages its own subtree
(verified: `mkdir` + `cgroup.kill` work from a transient user unit with `PrivateTmp`, killing a
`setsid` tree of three processes).

Agent environment gains `MSBUILDNODEREUSE=0` and `DOTNET_CLI_USE_MSBUILD_SERVER=0`: build nodes die
with their bash call anyway, and the flags stop `dotnet build` from trying to leave them behind. Builds
inside one call still parallelise normally.

## C. Stage changes

- **Conflict flow** loses the implementer's separate browser QA. For a UI surface the verifier's browser
  pass on the shared instance is the evidence: `publishEvidence` gains an overload taking an absolute
  directory, and the conflict flow publishes `<verifier runDir>/evidence` (PNG/GIF/WebM, same
  sanitising and limits as `.qa` evidence) with the note "Conflict-resolution QA evidence (independent
  verifier)".
- **Issue and feedback flows** keep the implementer's visual stage but run it against the shared
  instance; with a manifest `launch`, the implementer's main prompt no longer asks it to launch or
  capture evidence during implementation — capture happens in the visual stage.
- **Verifier prompt**, when an instance is present: the section above replaces the launch guidance;
  "restore and install first" stays (native tests still need it).

## D. Push-first conflict resolution

`handleMergeConflict`, fresh and resumed-merge paths:

1. `beginBaseMerge` → agent resolves (its prompt already restores and runs the repository's checks)
   → `stageBaseMerge`.
2. `assertPullRequestMergeContext` → `finishBaseMerge` (commit, push) → `markPullRequestOpen` →
   comment "🔀 Base-branch conflicts resolved and pushed. Verification follows." →
   `completeEvent`.
3. Inside `withAppInstance`: verifier (UI surface → browser pass). Pass → publish verifier evidence,
   comment "✅ Post-resolution verification passed" with the report path. Fail → comment
   "⚠️ Post-resolution verification failed — the resolution stays pushed; CI is the other check" with
   the summary and evidence note, `setStatus(pr_open, error)`, no label, no revert.

Failures before step 2 keep today's path exactly: abort, discard, ⛔, `pi-blocked`. A
`RetryableControllerError` between stage and push keeps the staged merge for the next tick, as today.
`/pi retry` semantics are unchanged; a failed post-resolution verification is re-run by the next push
to the PR (documented).

## E. Project memory

Per profile, i.e. per repository: `<dataDir>/memory/`, outside every worktree, never in git.

- **Files.** Markdown, one durable fact per file, `<slug>.md` matching `^[a-z0-9][a-z0-9-]{0,63}\.md$`
  (others are ignored and logged), ≤ 4 KB each, ≤ 40 files. First line `# <title>`. Facts are environment and repository knowledge: launcher timing, port conventions,
  seeded roles (never credentials), flaky tests and why, checks that fail on the base branch, what a
  previous attempt got wrong. Never issue-specific transient state, never secrets.
- **Prompt index.** `projectMemoryIndex(dir)` renders every file's title and first two body lines, newest
  first, capped at 6 KB, under "Project memory — notes from earlier runs; advisory, verify before
  relying on them". Implementer, visual and verifier prompts include it and the directory path; the
  instructions say to read a note's file before acting on it, and at the end of the run to save new
  durable findings, one per file, updating an existing file instead of duplicating.
- **Secret filter.** Files whose content matches token/credential patterns (`gh[pousr]_[A-Za-z0-9]{20,}`,
  `Bearer `, `password\s*[:=]`, `cookie:`, private-key headers) are excluded from the index and named in
  the worker log; the harness never renders them.
- **Harness entries.** The instance lifecycle writes `instance-timing.md` after each launch (readiness
  and auth durations, launch failures with their phase). Cheap, and the next run's timeout guess is
  informed.
- **Trust.** Memory is data the agents wrote; prompts say so. The verifier reads it like any other
  repository text: guidance, never evidence.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_WORKER_APP_START_TIMEOUT` | `900` | seconds for launch + endpoints + readiness |
| `PI_WORKER_APP_MIN_AVAILABLE_MB` | `4096` | refuse to launch below this `MemAvailable` |

Both documented in `.env.example` and the README.

## Expected timings (GeoWiki conflict retry, warm caches)

resolve 2 min → push → launch + readiness + auth ≈ 1.5 min → verifier restore/build/tests/checks ≈ 7
min → browser pass ≈ 1 min → report ≈ 2 min: **≈ 13–14 minutes**, one stack, no leak.

## Testing

- `test/app-instance.test.ts`: a fake launcher (bash script that starts `python3 -m http.server` on a
  free port and prints nothing useful) with a static `readiness.endpoints`; readiness success, readiness
  timeout, launcher exit before readiness, auth setup writing a storage state, `ensureCurrent`
  relaunch on fingerprint change, memory guard refusal (`/proc/meminfo` injected).
- `test/cgroup.test.ts`: `available()` false in an unwritable path → no-ops; on a host where the
  worker's cgroup is writable (opt-in `PI_WORKER_CGROUP_SMOKE=1`, run under `systemd-run --user`):
  a `setsid` tree is killed at bash-call end.
- Flow tests: conflict push-first ordering and both failure paths; verifier evidence publication;
  stage wrapper stops the instance on success, failure and abort; issue flow implementer prompt
  variant with/without `launch`.
- Prompt tests: instance section rendering, e2e prohibition, memory index inclusion.
- Manifest tests: `readiness.endpoints` parsing and rejection of non-loopback or non-http URLs.
- Memory tests: index cap, ordering, secret filter, 4 KB/40-file limits.
- `test/systemd.test.ts`: `Delegate=yes` in both units.
- Live: one GeoWiki conflict retry with the manifest on `dev` (#580 merged), timings recorded in
  `instance-timing.md`; `npm run check` green (currently 174 tests).
