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

Current units permit trusted controller writes to `~/.pi/agent` because the Pi SDK locks and may refresh auth state. Sandboxed agent commands still cannot read that directory.

Verify:

```bash
systemctl --user cat pi-issue-worker-supervisor.service | grep ReadWritePaths
```

Expected paths include:

```text
%h/.local/share/pi-issue-worker %h/.cache %h/.pi/agent
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
```

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

Claimed implementations and `addressing_review` jobs resume from SQLite and persistent Pi sessions. Existing commits and draft PRs are rediscovered instead of blindly duplicated.

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
