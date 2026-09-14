# Troubleshooting the GitHub issue worker

Start with the symptom table, then use the diagnostic sections below. Do not delete locks, state, worktrees, or sessions while a worker process is running.

## Quick status checklist

```bash
systemctl --user is-enabled pi-issue-worker-supervisor.service
systemctl --user is-active pi-issue-worker-supervisor.service
systemctl --user status pi-issue-worker-supervisor.service --no-pager
journalctl --user -u pi-issue-worker-supervisor.service --since '-30 minutes' --no-pager
```

Confirm the installed commands and prerequisites:

```bash
command -v node npm git gh pi-issue-worker pi-issue-worker-supervisor
command -v bwrap socat rg              # Linux
node --version                          # must be v24+
gh auth status
```

Inspect profile permissions without printing credentials:

```bash
find ~/.config/pi-issue-worker -maxdepth 1 -printf '%M %f\n' | sort
```

Expected permissions:

```text
drwx------ pi-issue-worker
-rw------- repository-name.env
```

## Symptom reference

| Symptom | Likely cause | First action |
|---|---|---|
| Supervisor command exits without output | old installation with a broken npm-bin main check | rerun the installer from an updated checkout |
| `Sandbox dependencies not available: socat not installed` | missing Linux proxy relay | install `socat` and restart/test again |
| Bubblewrap reports an operation-not-permitted/user namespace error | Ubuntu AppArmor user namespace restriction | inspect `kernel.apparmor_restrict_unprivileged_userns` |
| `apply-seccomp: No such file or directory` inside sandbox | old worker did not allow its packaged runtime helpers | update/reinstall the worker |
| `EROFS ... ~/.pi/agent/auth.json.lock` | old systemd unit made Pi auth state read-only | reinstall units and verify `ReadWritePaths` |
| One profile exits every 15 seconds | invalid profile, auth failure, lock conflict, or startup error | inspect the journal around the first exit |
| `Worker profile is already running` | supervisor and template instance overlap, or another manual worker is active | stop the duplicate process; do not delete a live lock |
| Profile permission error | profile is not mode 0600 or config directory is writable by group/other | correct permissions |
| Duplicate repository/shared data directory error | two profiles would share identity or state | assign one profile per repository and a unique data directory |
| Worker cannot find `uv`, `pnpm`, or `dotnet` | systemd manager has a minimal `PATH` | add an absolute `PATH` service override |
| Custom data directory fails with `EROFS` | systemd `ProtectSystem` does not allow that path | add the path to `ReadWritePaths` |
| `--check` fails while service is healthy | profile lock is already held by the service | stop the service before interactive checks |
| Issue remains untouched | no exact ready label, wrong repository, closed issue, or worker unhealthy | inspect labels, queue, service, and profile |
| Conversation feedback is ignored | comment lacks `/pi` or author association is untrusted | use `/pi ...` from a configured association |
| Draft PR checks fail with no worker response | old installation, worker stopped, or PR job missing from local state | update/restart, inspect `gh pr checks`, issue labels, and the journal |
| Chromium reports `Unix sockets are blocked` or `ProcessSingleton` errors | outdated visual sandbox or an overlong temp/socket path | update, then run the browser smoke test below |
| Playwright gets `net::ERR_ACCESS_DENIED` on a local URL `curl` reaches; evidence or `npm run check` fails with `bwrap: … Operation not permitted` | Ubuntu's `apparmor_restrict_unprivileged_userns` on kernel ≥ 7.0 confines the namespaced units | `journalctl -k | grep 'apparmor="DENIED"'`; see the kernel 7.0 entry under "An issue becomes blocked" |
| `App instance memory failed: N MB available, 4096 MB required` | the host is short of memory (other stacks, swap in use) | free memory or lower `PI_WORKER_APP_MIN_AVAILABLE_MB`; never let a launch swap for ten minutes |
| `App instance readiness failed` / `App instance endpoints failed` | the manifest launcher died or a resource never came up | read `<data-dir>/instances/issue-<n>/<run>/launch.log` (tail is in the error); inotify and ports are the usual causes |
| `App instance auth failed: … must be gitignored` | the repository tracks its QA storage state | gitignore `auth.storageState` in the repository |
| `⚠️ Post-resolution verification failed` on a PR | the pushed conflict resolution did not pass the independent verifier | read the report path in the comment; the resolution stays pushed, fix forward on the PR |
| Worker is idle but memory use is high | each profile loads an independent Pi SDK/model runtime | reduce active profiles or run selected profiles |

## Supervisor and child lifecycle

Show the complete service process tree:

```bash
systemctl --user status pi-issue-worker-supervisor.service --no-pager
```

A healthy two-profile setup normally shows:

- one `pi-issue-worker-supervisor` Node process;
- two `dist/src/index.js` child processes;
- transient Git, GitHub CLI, sandbox, test, or build processes while work is active.

Check restart counters:

```bash
systemctl --user show pi-issue-worker-supervisor.service \
  -p MainPID -p NRestarts -p MemoryCurrent
```

The supervisor logs child starts and exits. Individual tool calls are recorded in each profile's compact issue log rather than copied into the systemd journal.

If the service repeatedly restarts children:

```bash
journalctl --user -u pi-issue-worker-supervisor.service \
  --since '-10 minutes' --no-pager
```

Fix the first reported error. Later lines are often only the 15-second restart loop.

### Slow or timed-out shutdown

Current supervisor units use `KillMode=control-group`, allowing systemd and the supervisor to signal every worker child. Verify the installed unit:

```bash
systemctl --user cat pi-issue-worker-supervisor.service | grep KillMode
```

Expected:

```text
KillMode=control-group
```

If an older unit uses `KillMode=mixed`, rerun the installer and reload systemd.

## Sandbox failures

Everything in this section applies only with `PI_WORKER_SANDBOX=1`. The switch is **off by default for
now** (see the README's "Sandboxing" section), in which case agent commands run directly under the
worker's own systemd unit and none of the bwrap/socat/seccomp material below is in play.

### Missing Linux commands

```bash
command -v bwrap socat rg
```

Ubuntu/Debian installation:

```bash
sudo apt-get install bubblewrap socat ripgrep
```

### Ubuntu user namespaces

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns
unshare --user --map-root-user true
bwrap --ro-bind / / --proc /proc --dev /dev true
```

If the sysctl is `1` and namespace commands fail, prefer a scoped AppArmor policy. A temporary system-wide diagnostic is:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Restore the setting after diagnosis if it is not part of the approved host policy.

### Network access denied

Sandbox network access is allowlisted. Add only required hosts to the repository profile:

```dotenv
PI_WORKER_SANDBOX_ALLOWED_DOMAINS=api.nuget.org,globalcdn.nuget.org,*.nuget.org
```

Common examples:

- Python: `pypi.org`, `*.pypi.org`, `files.pythonhosted.org`;
- .NET: `api.nuget.org`, `globalcdn.nuget.org`, `*.nuget.org`;
- private package registry: its exact API and artifact hostnames;
- browser QA: the exact application/API/CDN hosts.

Restart the supervisor after profile changes.

Do not add credentials or broad catch-all wildcards to the allowlist.

### Packaged seccomp helper is inaccessible

An error similar to this indicates an outdated installation:

```text
.../@anthropic-ai/sandbox-runtime/vendor/seccomp/.../apply-seccomp: No such file or directory
```

The worker package itself lives under the user home, which the sandbox otherwise denies. Current versions explicitly allow the non-secret packaged runtime helper directory. Update and reinstall:

```bash
cd ~/dotfiles
./scripts/setup-pi-issue-worker.sh
systemctl --user restart pi-issue-worker-supervisor.service
```

### Browser or Playwright socket failures

Current Linux visual runs use a short private directory under `/run/user/<uid>`, hide `/tmp`, `/var`,
the home directory, and unrelated runtime entries, and permit Unix sockets only for the requested browser run. Verify the complete
stateful Playwright path from an updated package checkout:

```bash
cd ~/dotfiles/pi/github-issue-worker
PI_WORKER_BROWSER_SMOKE=1 npx tsx --test test/browser-sandbox.integration.test.ts
```

An error containing `listen EINVAL` can mean the Unix socket path exceeded Linux's roughly 108-byte
limit. Do not override `CLAUDE_CODE_TMPDIR` with a long path. `Unix sockets are blocked` usually means an
older worker did not enable the visual-only socket mode. `ProcessSingleton` errors generally mean the
private temp directory was absent or not writable. Reinstall and restart after updating.

Linux seccomp cannot allowlist Unix sockets by path. The visual mode therefore relies on filesystem and
network-namespace isolation to hide host socket locations and should run under a dedicated OS account.
Non-visual Pi runs keep Unix sockets blocked.

## Authentication problems

### GitHub CLI works interactively but not under systemd

A desktop keyring may not be available to a headless user service. Prefer a repository-scoped token in each mode-0600 profile:

```dotenv
GH_TOKEN=github_pat_REDACTED
```

Do not put a shared parent `GH_TOKEN` only in the supervisor shell environment; the supervisor intentionally scrubs parent GitHub token variables before applying profiles.

Check the effective identity manually while the service is stopped:

```bash
systemctl --user stop pi-issue-worker-supervisor.service
pi-issue-worker-supervisor --check
systemctl --user start pi-issue-worker-supervisor.service
```

### Pi authentication lock is read-only

Symptom:

```text
EROFS: read-only file system, mkdir '~/.pi/agent/auth.json.lock'
```

Current units permit trusted controller writes to `~/.pi/agent` because the Pi SDK locks and may refresh auth state. With sandboxing on, agent commands cannot read that directory; with it off, bash commands that reference it are policy-blocked instead.

Verify:

```bash
systemctl --user cat pi-issue-worker-supervisor.service | grep ReadWritePaths
```

Expected paths include:

```text
%h/.local/share/pi-issue-worker %h/.cache %h/.pi/agent %t
-%h/.nuget -%h/.aspire -%h/.dcp -%h/.dotnet -%h/.microsoft -%h/.aspnet -%h/.local/share/pnpm -%h/.npm
```

Rerun the installer when the path is missing.

## Profile validation failures

### Permissions

```bash
chmod 700 ~/.config/pi-issue-worker
chmod 600 ~/.config/pi-issue-worker/*.env
```

Profiles may contain GitHub tokens and must not be symlinks. The supervisor also rejects a symlinked or group/world-writable configuration directory.

### Repository or state collision

Every active profile needs:

- one unique `PI_WORKER_REPOSITORY`;
- one unique canonical `PI_WORKER_DATA_DIR`.

Avoid paths that differ only by symlink aliases. On case-insensitive filesystems, avoid paths that differ only by letter case.

### Wrong default branch

The base is explicit; the worker never guesses it. Query GitHub:

```bash
gh repo view acme/widgets --json defaultBranchRef \
  --jq .defaultBranchRef.name
```

Set that exact value:

```dotenv
PI_WORKER_BASE_BRANCH=main
```

## Repository tools missing under systemd

Inspect paths:

```bash
command -v uv pnpm dotnet playwright-cli
systemctl --user show-environment | grep '^PATH='
```

Create an override with absolute paths:

```bash
systemctl --user edit pi-issue-worker-supervisor.service
```

```ini
[Service]
Environment="PATH=/home/USERNAME/.local/bin:/home/USERNAME/.local/share/pnpm:/home/USERNAME/.dotnet:/usr/local/bin:/usr/bin:/bin"
Environment="DOTNET_ROOT=/home/USERNAME/.dotnet"
```

`DOTNET_ROOT` matters as soon as agents run unsandboxed: a user-local .NET install found only through
`PATH` is invisible to tools that launch the runtime host themselves (Aspire's AppHost, `dotnet test`
hosts), which then fail with a missing-runtime error or need the variable set by hand in every command.

Reload and restart after editing.

## Custom data directory is read-only

The hardened units permit writes under the default data root. For a profile outside it:

```bash
systemctl --user edit pi-issue-worker-supervisor.service
```

```ini
[Service]
ReadWritePaths=/absolute/custom/worker-data
```

Multiple `ReadWritePaths=` entries are additive unless explicitly reset. Reload and restart after editing.

## An issue is not claimed

Check the profile and service first, then inspect the exact queue:

```bash
gh issue list --repo acme/widgets \
  --state open --label pi-ready \
  --json number,title,url
```

Confirm:

1. the issue is open;
2. the label exactly matches `PI_WORKER_READY_LABEL` or `<prefix>-ready`;
3. the profile points at the same `owner/repository`;
4. the service is active without a child restart loop;
5. no existing job for the issue is already active or blocked.

The worker intentionally processes sequentially within each repository. A long-running issue delays the next issue in that profile, while other repository children continue independently.

## An issue becomes blocked

The worker applies `pi-blocked`, removes active labels, and posts a summarized error when possible. Inspect:

```bash
gh issue view 123 --repo acme/widgets --comments
```

Local lifecycle log:

```bash
tail -100 ~/.local/share/pi-issue-worker/acme-widgets/logs/issue-123.log
```

Typical causes:

- sandbox prerequisites or network host missing;
- model authentication unavailable;
- protected path required by the issue;
- Pi returned `BLOCKED` because requirements were ambiguous;
- no tracked changes were produced;
- tests failed and Pi could not safely repair them.

After correcting the cause, use the documented retry command on the PR when one exists, or reapply the ready label to a blocked initial issue.

### `Independent QA BLOCKED: … backend/… unavailable` or `preflight failed … waits on unavailable backend`

The verifier or the visual run found nothing listening on the application's documented ports and gave
up instead of launching the stack. Check, in order:

1. `PI_WORKER_SANDBOX` — with it on, the run cannot reach host-loopback services (shared Postgres,
   Redis, MinIO) or toolchain caches under `$HOME` at all; that is the known gap sandboxing is currently
   off for. Set it to `0` for the profile and restart.
2. The unit's `ReadWritePaths` — with sandboxing off, `ProtectHome=read-only` still applies to agent
   commands, so `dotnet restore`, `aspire`, dev-certs or a package store failing with `EROFS`/"read-only
   file system" means the toolchain home is missing from the second `ReadWritePaths` line in
   `systemd/*.service`. Add it and `systemctl --user daemon-reload && systemctl --user restart …`.
3. The host services themselves — `ss -ltn | grep -E ':(5432|6379|9000)\b'`. The agent is told to start
   the *application* from the repository's documented isolated launcher, not the shared infrastructure.
4. The verifier's `evidence/report.md` in the run directory named in the error: an agent that did try to
   launch records the exact failure there, and that failure is the real bug.

### `diff-review … Unresolved index entries exist` during a base-branch conflict resolution

Fixed: the controller now stages the agent's resolution before the QA gate. If it recurs, the agent left
real conflict markers or unresolved paths, and the same message names them.

### `Cannot update from origin/<base> with existing worktree changes` on a conflict retry

Fixed: an abandoned resolution is now discarded from the worktree (`reset --hard` + `clean -fd`, ignored
build outputs and `.qa` kept) when the controller blocks. A worktree left dirty by an older worker still
needs one manual `git checkout -- <path>` in `<data-dir>/worktrees/pr-<n>`, then `/pi retry` on the PR.

### `.NET test hosts fail with "user limit (128) on the number of inotify instances"`

ABP/ASP.NET test hosts each register file watchers; a parallel `dotnet test` run exhausts the Linux
default of 128 inotify instances per user and the affected tests fail inside host creation before their
bodies run. Host setting, operator decision — the usual developer-box value:

```bash
sudo sysctl -w fs.inotify.max_user_instances=1024   # persist in /etc/sysctl.d/
```

### `net::ERR_ACCESS_DENIED` from Playwright on a local URL `curl` reaches, or `bwrap: … Operation not permitted` / `setting up uid map: Permission denied`

Both are AppArmor verdicts from Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1`, and both
appeared on the first boot of a 7.0 kernel (6.17 permitted the same operations). Confirm with the audit
log and the worker's own label:

```bash
journalctl -k --since '30 min ago' -o cat | grep 'apparmor="DENIED"' | grep -E 'profile="(chrome|unprivileged_userns)"'
#  … class="net" info="failed af match" profile="chrome" comm="Chrome_ChildIOT" family="inet" …
#  … class="cap"  profile="unprivileged_userns" comm="bwrap" capname="net_admin" …
#  … class="file" info="Failed name lookup - disconnected path" profile="unprivileged_userns" name="proc/…/uid_map" comm="bwrap" …
cat /proc/$(pgrep -f 'pi-issue-worker-supervisor' | head -1)/attr/apparmor/current   # unprivileged_userns (enforce)
```

Why the worker is labelled at all: the units use `PrivateTmp`/`ProtectSystem`/`ProtectHome`/
`ReadWritePaths`. For a `systemd --user` manager those need a mount namespace, which an unprivileged
user only gets inside a user namespace, so with the sysctl on every worker process — and every agent,
browser and toolchain it spawns — runs under the `unprivileged_userns` profile. That profile allows
`network` and files, which is why `curl`, `dotnet` and `pnpm` are fine. Two things are not:

- **Google Chrome.** `playwright-cli` defaults to the `chrome` channel, `/opt/google/chrome/chrome`, the
  one binary on the host with its own profile (`/etc/apparmor.d/chrome`, `flags=(unconfined)`, shipped
  only to grant `userns`). Exec'ing it yields the stacked label `chrome//&unprivileged_userns (mixed)`,
  and from kernel 7.0 on the `chrome` half fails the address-family match (it has no network rules and
  its `unconfined` flag is not honoured inside a mixed stack): `socket()` → `EACCES` →
  `net::ERR_ACCESS_DENIED`. The agent's visual run and the verifier both break; the repository's own
  Playwright tests do not, because they launch Playwright's pinned Chromium, which has no profile.
- **bwrap.** Evidence publishing re-encodes every attachment (PNG screenshots included) with ffmpeg
  inside `bwrap --unshare-all`. On 7.0 the `unprivileged_userns` profile denies the `uid_map` write and
  the `net_admin`/`setpcap` capabilities bwrap needs, so no namespace can be built — from the worker
  *or* from an unconfined shell (bwrap's own `unshare` triggers the same transition). A PNG that cannot
  be sanitized fails the run, and `npm run check` fails its nine evidence tests on such a host.

Fix, host level (operator decision). The pre-reboot behaviour is restored in one setting, persisted so a
later boot keeps it, followed by a supervisor restart so the units are re-spawned without the label:

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-pi-issue-worker-userns.conf
sudo sysctl -p /etc/sysctl.d/60-pi-issue-worker-userns.conf
systemctl --user restart pi-issue-worker-supervisor.service
```

That disables Ubuntu's host-wide user-namespace hardening for every unprivileged process, not just the
worker. The scoped alternative needs more: `printf 'network,\n' | sudo tee /etc/apparmor.d/local/chrome
&& sudo apparmor_parser -r /etc/apparmor.d/chrome` cures Chrome, but bwrap under the namespaced units
stays stacked with `unprivileged_userns`, so the units would also have to drop their mount-namespace
options and `/usr/bin/bwrap` would need its own `userns` profile.

Verify from a namespaced transient unit — a bare `systemd-run --user` without `PrivateTmp` passes even
while the worker fails, because only the namespaced unit gets the label:

```bash
systemd-run --user --collect --wait --pipe -p PrivateTmp=true -E HOME=$HOME -E PATH=$PATH \
  --working-directory=/tmp playwright-cli -s=probe open http://localhost:<port>/
systemd-run --user --collect --wait --pipe -p PrivateTmp=true \
  bwrap --unshare-all --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev /usr/bin/true
```

### `App instance … failed` (a manifest `launch` is declared)

The worker launched the repository's stack itself and gave up in the named phase. Everything it saw is
under `<data-dir>/instances/issue-<n>/<run>/`: `launch.log` (the launcher's output, its tail is quoted in
the error), `auth-setup.log`, and `instance.json` once it got that far. In order:

1. `memory` — `MemAvailable` was below `PI_WORKER_APP_MIN_AVAILABLE_MB`. Other stacks on the host
   (interactive worktrees, leftover orchestrators: `pgrep -fa 'dcp run-controllers'`) are the usual reason.
2. `endpoints` / `readiness` — the launcher exited, or a resource never reached `Running`/answered its
   probe within `PI_WORKER_APP_START_TIMEOUT`. On a .NET/Aspire stack a migrator or host that dies at
   startup while the CLI log shows nothing is very often the per-user inotify limit (each ASP.NET host
   registers file watchers; test hosts from the verifier's own run count too):

   ```bash
   sysctl fs.inotify.max_user_instances      # 128 by default; 1024 is the usual developer-box value
   find /proc/[0-9]*/fd -lname 'anon_inode:inotify' -user "$USER" 2>/dev/null | wc -l
   ```

3. `auth` — the setup command failed (its output is in `auth-setup.log`), the storage state was not
   produced at `auth.storageState`, or that path is not gitignored.

The agent never launches while `launch` is declared; if a run still shows the agent starting the stack,
the manifest did not load (`.pi-worker/qa.json` malformed — the worker logs the reason).

### `⚠️ Post-resolution verification failed` after a conflict resolution

The resolution was pushed before the independent verifier ran; the comment carries the verifier's summary
and, when there is one, the local report path. Nothing is reverted: fix forward on the PR, or push to it —
the next push re-enters the normal PR flow. A `⛔` comment, by contrast, means the resolution failed
*before* the push and was discarded; `/pi retry` re-runs it.

### Project memory looks stale or wrong

Notes live in `<data-dir>/memory/*.md` and are advisory. Delete or edit a wrong note by hand; a file the
worker skips (bad name, over 4 KB, secret-looking content) is named in the worker's journal line
`memory note skipped`. `instance-timing.md` is rewritten by the worker after every launch.

### Retrying a blocked base-branch conflict resolution

Post a trusted `/pi retry` on the PR. The controller forgets the processed
`merge-conflict:<pr>:<base>:<head>:<base-oid>` event and re-runs the resolution on its next poll; the PR's
base commit as GitHub reports it (`baseRefOid`) does not move when the base branch does, so without the
retry the block would persist until the PR head changed.

## Draft PR CI is failing or unattended

Inspect the current rollup without printing logs:

```bash
gh pr checks 123 --repo acme/widgets
gh pr view 123 --repo acme/widgets --json headRefOid,statusCheckRollup
```

The worker waits while any check is pending. Once all registered checks complete, it handles each failed
head SHA once, retrieves only bounded failed-job output, scrubs common credentials, and asks the existing
issue session for a focused repair. A pushed repair starts a new check cycle. The default maximum is
three attempts and can be changed per profile:

```dotenv
PI_WORKER_MAX_CI_FIX_ATTEMPTS=3
```

When the worker marks `pi-blocked`, inspect the PR and issue comments. External outages, missing CI
secrets, flaky infrastructure, protected workflow changes, and failures that produce no safe tracked
change intentionally require a human. After resolving the blocker, `/pi retry` clears the handled marker
for the current head and starts a fresh bounded repair cycle in the persistent session. The worker never
reruns Actions directly, weakens tests, changes protected workflow
files, merges, force-pushes, or rebases automatically.

If a PR created by an older installation has never been monitored, update and restart the worker. Confirm
the source issue still has `pi-pr-open`, the PR is open, and the profile child is healthy. An interrupted
`addressing_ci` run resumes from SQLite without incrementing the same head twice.

## PR feedback is ignored

Formal reviews and inline review comments are accepted automatically only from configured trusted associations. Ordinary PR conversation comments must begin with `/pi`:

```text
/pi fix handle the empty state described above
/pi retry
/pi verify visual
/pi verify gif
/pi stop
/pi help
```

Check `PI_WORKER_TRUSTED_ASSOCIATIONS` when a legitimate maintainer is ignored. Worker-authored comments contain a hidden marker and are always ignored to prevent loops.

For a PR the worker did not create, a `/pi` comment alone is intentionally insufficient: apply `pi-ready` to the PR to authorize adoption. Confirm it appears in:

```bash
gh pr list --repo acme/widgets --state open --label pi-ready
```

Adoption fails closed for fork heads, a base other than `PI_WORKER_BASE_BRANCH`, a branch/path identity mismatch, or an existing colliding state record. Successful adoption removes `pi-ready`, creates `PI_WORKER_DATA_DIR/worktrees/pr-<number>`, and adds `pi-pr-open`.

## Merged PR worktree was not removed

Cleanup runs inside every repository poll. It removes a managed worktree only after GitHub reports the PR as merged and only when the registered worktree is clean and every commit on it is contained in the merged PR head, which the controller fetches from `refs/pull/<n>/head` when it is not already local. A worktree that is merely *behind* the merged head (for example after a remote "Update branch" merge) is removed; one holding a commit the merged head does not contain is preserved with `not contained in merged PR head` in `last_error`. Inspect the job's `last_error` and the child journal; do not force-remove a dirty or diverged path. Closed-unmerged PRs are retained intentionally.

## Inspecting state safely

Per-profile layout:

```text
PI_WORKER_DATA_DIR/
├── repository/
├── worktrees/
├── sessions/
├── logs/
├── state.sqlite
└── worker.lock
```

The GitHub issue and PR are the primary user-facing status. For local state, stop the profile before performing maintenance. Do not edit SQLite directly.

A `worker.lock` contains the owning PID. The next worker automatically reclaims a well-formed lock when that PID is dead. If the PID is alive, do not remove the lock. If the file is malformed, stop all worker processes and inspect the data directory before manual cleanup.

## Safe restart and update procedure

```bash
systemctl --user stop pi-issue-worker-supervisor.service
cd ~/dotfiles
git pull
./scripts/setup-pi-issue-worker.sh
systemctl --user daemon-reload
systemctl --user start pi-issue-worker-supervisor.service
systemctl --user status pi-issue-worker-supervisor.service
```

Claimed implementations, `addressing_review` jobs, and interrupted `addressing_ci` repairs resume from
SQLite and persistent Pi sessions. Existing commits and draft PRs are rediscovered instead of blindly
duplicated; handled CI head SHAs and bounded attempt counts remain idempotent across restarts.

## Collecting a diagnostic summary

The following avoids printing profile contents or tokens:

```bash
node --version
gh auth status
command -v bwrap socat rg
systemctl --user cat pi-issue-worker-supervisor.service
systemctl --user show pi-issue-worker-supervisor.service \
  -p MainPID -p NRestarts -p MemoryCurrent
find ~/.config/pi-issue-worker -maxdepth 1 -printf '%M %f\n' | sort
journalctl --user -u pi-issue-worker-supervisor.service \
  --since '-30 minutes' --no-pager
```

Redact repository names, filesystem paths, issue text, and authentication output as required before sharing logs.

See [Installation and operations](installation.md) for the complete setup sequence.
