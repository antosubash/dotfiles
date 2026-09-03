# Installation and operations guide

This guide installs the headless issue worker, configures one or more repository profiles, validates the setup, and starts either individual workers or the multi-repository supervisor.

The installer is intentionally passive: it installs files and reloads the user systemd manager, but it does not create GitHub labels, enable a service, or process an issue. Those mutations begin only when you run `--once` or start a worker service.

## 1. Choose the host and identity

Use a continuously available Linux or macOS host. A dedicated OS account and a dedicated GitHub App or machine-user identity are recommended. The GitHub identity needs permission to:

- read and push repository contents;
- read and edit issues and labels;
- read reviews and comments;
- create and update pull requests.

The worker never merges a pull request.

## 2. Install prerequisites

### Common requirements

```bash
node --version       # v24 or newer
git --version
gh --version
pi --version
```

Authenticate GitHub and Pi before installing:

```bash
gh auth status
pi
```

Exit Pi after confirming that an authenticated model is available.

Optional evidence tools:

```bash
playwright-cli --help
ffmpeg -version
```

### Linux sandbox requirements

Install Bubblewrap, socat, and ripgrep. On Ubuntu or Debian:

```bash
sudo apt-get update
sudo apt-get install bubblewrap socat ripgrep
```

Confirm that all three commands resolve:

```bash
command -v bwrap
command -v socat
command -v rg
```

Ubuntu 24.04 and newer commonly set:

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns
```

A value of `1` may prevent Bubblewrap and the sandbox seccomp layer from creating capability-bearing user namespaces. Prefer a scoped AppArmor policy that grants the required `userns` permission to the sandbox binaries. For temporary local testing, the upstream sandbox documentation also describes:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

That command weakens the restriction system-wide until it is restored or the host reboots. Do not make it persistent without reviewing the host security implications.

Basic namespace checks:

```bash
unshare --user --map-root-user true
bwrap --ro-bind / / --proc /proc --dev /dev true
```

The worker fails closed when sandbox initialization fails. `pi-issue-worker --check` validates configuration and authentication, but it does not execute an agent command inside the OS sandbox.

### macOS sandbox requirements

Install ripgrep and the optional evidence tools with Homebrew. macOS uses `sandbox-exec`; `bubblewrap` and `socat` are Linux-only requirements.

## 3. Install the package and units

From the dotfiles checkout:

```bash
cd ~/dotfiles
./scripts/setup-pi-issue-worker.sh
```

The script:

1. checks Node, npm, Git, and GitHub CLI;
2. installs dependencies and runs the worker tests;
3. packs and installs the package under `~/.local`;
4. creates mode-0700 configuration and data roots;
5. installs the user systemd units on Linux;
6. reloads the user systemd manager.

It installs these commands:

```text
~/.local/bin/pi-issue-worker
~/.local/bin/pi-issue-worker-supervisor
```

Ensure `~/.local/bin` is available in interactive shells:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 4. Create repository profiles

Use one dotenv file per repository. The profile filename becomes the supervisor profile name.

```bash
mkdir -p ~/.config/pi-issue-worker
chmod 700 ~/.config/pi-issue-worker
cp ~/dotfiles/pi/github-issue-worker/.env.example \
  ~/.config/pi-issue-worker/widgets.env
chmod 600 ~/.config/pi-issue-worker/widgets.env
```

Minimal profile:

```dotenv
PI_WORKER_REPOSITORY=acme/widgets
PI_WORKER_REPOSITORY_URL=https://github.com/acme/widgets.git
PI_WORKER_BASE_BRANCH=main
PI_WORKER_DATA_DIR=~/.local/share/pi-issue-worker/acme-widgets
```

Recommended production settings:

```dotenv
PI_WORKER_LABEL_PREFIX=pi
PI_WORKER_POLL_SECONDS=60
PI_WORKER_MAX_ISSUES_PER_POLL=1
PI_WORKER_MAX_CI_FIX_ATTEMPTS=3
PI_WORKER_AGENT_TIMEOUT_MINUTES=60
PI_WORKER_MODEL=openai-codex/gpt-5.6-terra
PI_WORKER_THINKING_LEVEL=high
PI_WORKER_TRUSTED_ASSOCIATIONS=OWNER,MEMBER,COLLABORATOR
PI_WORKER_PROTECTED_PATHS=.git,.github/workflows,.pi
PI_WORKER_QA_RETENTION_DAYS=14
```

Add package registries and application hosts required by sandboxed builds:

```dotenv
# Python example
PI_WORKER_SANDBOX_ALLOWED_DOMAINS=pypi.org,*.pypi.org,files.pythonhosted.org

# .NET example
PI_WORKER_SANDBOX_ALLOWED_DOMAINS=api.nuget.org,globalcdn.nuget.org,*.nuget.org
```

Defaults already include GitHub, npm registries, localhost, and the hostname from `PI_WORKER_APP_URL`.

### GitHub credentials

When no token is present, children use the authenticated `gh` keyring identity. For separate repository identities, put a repository-scoped token in each mode-0600 profile:

```dotenv
GH_TOKEN=github_pat_REDACTED
```

The supervisor deliberately removes parent-process GitHub token variables before applying each profile, preventing one sourced profile token from leaking into another child.

### Multiple repositories

Create additional files with distinct repositories and data directories:

```text
~/.config/pi-issue-worker/
├── widgets.env
├── blog.env
└── backend.env
```

The supervisor rejects:

- duplicate repository identities;
- shared or symlink-aliased data directories;
- symlinked profiles;
- profile files readable by group or other users;
- a group/world-writable profile directory.

## 5. Validate before enabling

Validate every profile:

```bash
pi-issue-worker-supervisor --check
```

Validate selected profiles:

```bash
pi-issue-worker-supervisor \
  --profile widgets \
  --profile blog \
  --check
```

A successful check prints one `Ready:` line per repository. The command may initialize local SQLite state, but it does not create labels or otherwise mutate GitHub.

Do not run `--check` while the same profiles are already active under systemd; the profile locks correctly reject the second process.

Review both ready queues before the first live start. Any existing open issue or pull request carrying `pi-ready` can be claimed immediately:

```bash
gh issue list --repo acme/widgets --state open --label pi-ready
gh pr list --repo acme/widgets --state open --label pi-ready
```

A ready PR is adopted only when its head branch belongs to the configured repository and its base matches `PI_WORKER_BASE_BRANCH`. The worker creates `worktrees/pr-<number>` from the exact remote PR head; it never creates a second PR for adopted work.

Run exactly one live poll when you want to test GitHub mutation and queue handling:

```bash
pi-issue-worker-supervisor --once
```

`--once` may create labels, claim an approved issue, modify the local control clone, push a branch, and open a draft PR.

## 6. Configure the systemd execution path

The systemd user manager often has a smaller `PATH` than an interactive shell. Repository checks may need user-installed tools such as `uv`, `pnpm`, `dotnet`, or `playwright-cli`.

Inspect the manager environment:

```bash
systemctl --user show-environment | grep '^PATH='
```

Create an override when required:

```bash
systemctl --user edit pi-issue-worker-supervisor.service
```

Example—replace `/home/USERNAME` with the absolute home path:

```ini
[Service]
Environment="PATH=/home/USERNAME/.local/bin:/home/USERNAME/.local/share/pnpm:/home/USERNAME/.dotnet:/home/USERNAME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
```

Then reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart pi-issue-worker-supervisor.service
```

The sandbox automatically permits reads from user-home directories present in `PATH`; writes remain limited to the issue worktree and temporary space.

When visual verification is required, validate the installed Chromium/Playwright path from the package
checkout before enabling production work:

```bash
cd ~/dotfiles/pi/github-issue-worker
PI_WORKER_BROWSER_SMOKE=1 npx tsx --test test/browser-sandbox.integration.test.ts
```

The Linux visual profile temporarily permits Unix sockets for Chromium and Playwright, while denying
reads from the home directory and common socket locations and exposing only a unique private temporary
subtree. Keep the worker on a dedicated OS account.

## 7. Start the worker

### Recommended: one supervisor for all profiles

```bash
systemctl --user enable --now pi-issue-worker-supervisor.service
systemctl --user status pi-issue-worker-supervisor.service
journalctl --user -u pi-issue-worker-supervisor.service -f
```

Each repository runs in a separate child process with separate SQLite state, locks, clones, worktrees, sessions, and logs. A failed child restarts independently after 15 seconds.

After adding or changing a profile:

```bash
systemctl --user restart pi-issue-worker-supervisor.service
```

### Alternative: one template instance

```bash
systemctl --user enable --now pi-issue-worker@widgets.service
journalctl --user -u pi-issue-worker@widgets.service -f
```

Never run a supervisor child and a template instance for the same profile simultaneously.

### Keep running after logout

On headless Linux hosts, enable user lingering if policy permits:

```bash
loginctl enable-linger "$USER"
```

## 8. Approve the first issue or existing pull request

The first live start creates:

- `pi-ready`;
- `pi-working`;
- `pi-pr-open`;
- `pi-blocked`;
- `pi-visual`.

Apply `pi-ready` only after reviewing the issue as an implementation request, or an existing PR as safe for controller-managed updates:

```bash
gh issue edit 123 --repo acme/widgets --add-label pi-ready
gh pr edit 456 --repo acme/widgets --add-label pi-ready
```

For an adopted PR, add a trusted `/pi fix ...` comment when a specific change is required. Label-only adoption still enables conflict handling and CI monitoring. Fork PRs and PRs targeting another base are blocked.

Expected lifecycle:

```text
pi-ready → pi-working → pi-pr-open
                         ↘ pi-blocked
```

The worker comments when it claims the issue and when it opens a draft PR. For an existing ready PR it comments when adoption starts, creates an isolated PR worktree, and does not open a duplicate. It then waits for the PR
check rollup. Completed failures trigger up to `PI_WORKER_MAX_CI_FIX_ATTEMPTS` repairs in the original
persistent Pi session; each pushed head is monitored independently. Passing checks are reported once,
and exhausted, external, or unsafe-to-fix failures receive `pi-blocked` and require a human. Human review
and merge remain mandatory.

## 9. Update or disable

Update from the dotfiles checkout:

```bash
cd ~/dotfiles
git pull
./scripts/setup-pi-issue-worker.sh
systemctl --user restart pi-issue-worker-supervisor.service
```

Disable without deleting state:

```bash
systemctl --user disable --now pi-issue-worker-supervisor.service
```

State remains under `~/.local/share/pi-issue-worker` for inspection or later recovery.

See [Troubleshooting](troubleshooting.md) for sandbox, authentication, profile, systemd, queue, and recovery diagnostics.
