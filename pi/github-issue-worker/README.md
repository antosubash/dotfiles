# Headless Pi GitHub issue worker

A reusable GitHub issue worker that turns explicitly approved issues into isolated Pi coding sessions
and draft pull requests. Each worker child remains bound to one repository; the optional supervisor runs
multiple profile-isolated children from one installation.

The worker deliberately does **not** auto-merge. GitHub labels, comments, pushes, commits, and PR
creation belong to the controller. Pi edits and verifies code inside an issue-specific linked worktree.

## Lifecycle

1. A maintainer applies `pi-ready` to an open issue.
2. The worker changes it to `pi-working`, fetches the configured base branch, and creates
   `pi/issue-<number>-<slug>` in a dedicated control clone.
3. Pi loads repository context files and safe non-executable resources. User and project executable
   extensions are disabled because they run in the controller process outside the tool sandbox. Pi works
   in a persistent issue session and may edit, test, and capture ignored evidence, but policy hooks block
   GitHub CLI use, git mutation, secret paths, CI workflows, and configured protected paths.
4. The controller validates the changed path set, commits, pushes, and opens a **draft** PR with
   `Closes #<number>`.
5. The worker monitors mergeability. When the configured base conflicts with the feature branch, the
   controller merges the freshly fetched base without rebasing, the same Pi session resolves unprotected
   conflicts and runs focused checks, and the controller validates and pushes the merge commit. Protected
   or ambiguous conflicts are blocked for human resolution.
6. The worker monitors the draft PR's check rollup. It waits for pending jobs, extracts bounded and
   scrubbed excerpts from completed failed Actions jobs, and sends actionable failures back to the same
   Pi session. The controller commits and pushes a repair, then monitors the new head. Attempts are
   bounded by `PI_WORKER_MAX_CI_FIX_ATTEMPTS` (default `3`); persistent or external failures are marked
   `pi-blocked` for human investigation.
7. Trusted formal reviews and inline review comments are sent back to the same Pi session. PR
   conversation comments require an explicit `/pi` command.
8. Every review, conflicting head/base pair, and CI-head event is persisted in SQLite, making handling
   idempotent across restarts.

Each repository child handles its work sequentially. This is intentional: repositories with integration
databases, browser sessions, or expensive builds should not be fanned out accidentally. A per-profile
`worker.lock` is acquired before SQLite opens; a concurrent instance exits with the owning PID. Different
profiles may run concurrently under the supervisor while retaining separate state and process boundaries.

## Requirements

- Node.js 24 or newer (`node:sqlite` is used)
- Git and GitHub CLI (`gh`), authenticated for the target repository
- Pi authentication in `~/.pi/agent` or `PI_CODING_AGENT_DIR`
- `playwright-cli` for visual evidence
- `ffmpeg` for optional GIF conversion
- Anthropic Sandbox Runtime prerequisites: on Linux, `bubblewrap`, `socat`, and `ripgrep`; macOS requires `ripgrep`. The worker fails closed if the OS sandbox cannot initialize.
- A dedicated GitHub App or machine-user identity is strongly recommended

The GitHub identity needs repository contents, issues, and pull-request write access. If the worker uses
your personal `gh` login, its branches, comments, and PRs appear as you.

Detailed guides:

- [Installation and operations](docs/installation.md)
- [Troubleshooting](docs/troubleshooting.md)

## Install

From the dotfiles checkout, install the CLI and user-service template:

```bash
~/dotfiles/scripts/setup-pi-issue-worker.sh
```

For package development or a manual installation:

```bash
cd ~/dotfiles/pi/github-issue-worker
npm ci
npm run check
npm install --global --prefix "$HOME/.local" .
```

Ensure `~/.local/bin` is on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Configure one repository

Create a mode-0600 environment file:

```bash
mkdir -p ~/.config/pi-issue-worker ~/.local/share/pi-issue-worker
cp .env.example ~/.config/pi-issue-worker/widgets.env
chmod 600 ~/.config/pi-issue-worker/widgets.env
```

Example repository profile:

```dotenv
PI_WORKER_REPOSITORY=acme/widgets
PI_WORKER_REPOSITORY_URL=https://github.com/acme/widgets.git
PI_WORKER_BASE_BRANCH=main
PI_WORKER_DATA_DIR=~/.local/share/pi-issue-worker/acme-widgets
PI_WORKER_PROTECTED_PATHS=.git,.github/workflows,.pi
PI_WORKER_APP_URL=http://localhost:3000
# Optional additional hosts for sandboxed build/browser verification (comma-separated)
PI_WORKER_SANDBOX_ALLOWED_DOMAINS=
PI_WORKER_MODEL=openai-codex/gpt-5.6-terra
PI_WORKER_THINKING_LEVEL=high
PI_WORKER_MAX_CI_FIX_ATTEMPTS=3
PI_WORKER_AGENT_TIMEOUT_MINUTES=60
# Docker is automatic when the socket exists; set 0 to disable it.
# PI_WORKER_ALLOW_DOCKER=0
# PI_WORKER_DOCKER_SOCKET=/var/run/docker.sock
PI_WORKER_PUBLISH_EVIDENCE=1
PI_WORKER_EVIDENCE_BRANCH=pi-evidence
```

Validate GitHub and Pi authentication without changing GitHub, then run one poll interactively:

```bash
set -a
. ~/.config/pi-issue-worker/widgets.env
set +a
pi-issue-worker --check
pi-issue-worker --once
```

`--check` is read-only with respect to GitHub and the target repository (it may initialize the local
state database). `--once` creates missing labels, updates the local control clone, and processes at most
one configured poll cycle.

On first start, the worker creates these configurable-prefix labels:

- `pi-ready` — maintainer approval and queue entry
- `pi-working` — claimed
- `pi-pr-open` — draft PR created
- `pi-blocked` — human help required
- `pi-visual` — request local browser evidence

## Run one profile as a user service

```bash
mkdir -p ~/.config/systemd/user
cp systemd/pi-issue-worker@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-issue-worker@widgets.service
journalctl --user -u pi-issue-worker@widgets.service -f
```

The supplied hardened units permit controller writes under `~/.local/share/pi-issue-worker`,
`~/.cache`, `~/.pi/agent` (the Pi SDK locks and may refresh its auth state), and the private user runtime
root used for visual browser sockets. Sandboxed agent commands
still cannot read the Pi agent directory. If a profile sets a different data directory, add that directory
to `ReadWritePaths` in a systemd override. Pi bash commands also run inside Anthropic Sandbox Runtime:
reads are denied across the home directory except the issue
worktree and required Git metadata, writes are limited to the worktree and temporary build space, and
network access uses an allowlist. Add project-specific browser/build hosts with
`PI_WORKER_SANDBOX_ALLOWED_DOMAINS`; do not put credentials or broad wildcards there.

## Run multiple repositories with the supervisor

Create one mode-0600 environment file per repository in `~/.config/pi-issue-worker`; the directory
must not be group/world writable. The supervisor parses these files as dotenv data without evaluating
shell commands, validates every profile before starting, and rejects duplicate repositories or shared
data directories. Parent-process GitHub token
environment variables are not shared; put a repository-scoped `GH_TOKEN` in each profile or use the
authenticated `gh` keyring identity.

```bash
cp .env.example ~/.config/pi-issue-worker/blog.env
chmod 600 ~/.config/pi-issue-worker/*.env
pi-issue-worker-supervisor --check
pi-issue-worker-supervisor --once
pi-issue-worker-supervisor
```

By default all `*.env` files are loaded in name order. Select a subset with repeated flags:

```bash
pi-issue-worker-supervisor --profile widgets --profile blog
```

In continuous mode each profile runs as an independent child process. An unexpected child exit restarts
only that profile after 15 seconds; override the delay with
`PI_WORKER_SUPERVISOR_RESTART_SECONDS`. `SIGINT` and `SIGTERM` are forwarded to all children.
Repository, data-directory, SQLite, clone, worktree, session, log, and profile-lock isolation remain
unchanged.

On Linux, run the hardened supervisor service instead of enabling every template instance:

```bash
systemctl --user enable --now pi-issue-worker-supervisor.service
journalctl --user -u pi-issue-worker-supervisor.service -f
```

Do not run the supervisor and `pi-issue-worker@<profile>.service` for the same profile at the same time.
The profile lock prevents concurrent state access, but the losing process will fail or repeatedly restart.
If a profile uses a data directory outside `~/.local/share/pi-issue-worker`, add it to `ReadWritePaths`
in a systemd override.

## Review commands

Trusted repository owners, members, and collaborators can write:

```text
/pi fix handle the empty state as discussed
/pi retry
/pi verify visual
/pi verify gif
/pi stop
/pi help
```

Formal PR reviews and inline review comments from trusted associations are processed automatically.
Ordinary PR conversation text is ignored unless it starts with `/pi`. Worker-authored comments carry a
hidden marker and are ignored, preventing feedback loops.

## Visual evidence

Visual evidence is local and intentionally untracked:

```text
<issue-worktree>/.qa/issues/<issue>/pr-<pr>/
├── latest -> runs/<timestamp>/
└── runs/<timestamp>/
    ├── desktop.png
    ├── mobile.png
    ├── workflow.webm
    ├── workflow.gif
    ├── snapshot.txt
    ├── console.log
    ├── requests.txt
    └── report.md
```

The controller adds `/.qa/` to its private control clone's Git exclude and never stages it on the feature
branch. By default it rejects symlinked evidence, decodes and deterministically re-encodes PNG/GIF/WebM
inside a credential-free networkless media sandbox, enforces per-file and per-run size limits, publishes
sanitized artifacts to the orphan `PI_WORKER_EVIDENCE_BRANCH`, and embeds the images/GIF in the PR
comment. Set `PI_WORKER_PUBLISH_EVIDENCE=0` to keep evidence local only. Old local timestamped runs are
removed after `PI_WORKER_QA_RETENTION_DAYS`; published branch history is retained.

Pi uses a unique `playwright-cli` session, takes an accessibility snapshot before interaction, checks
console/network failures, and closes the browser session. GIF requests record WebM and use `ffmpeg` for
conversion. On Linux, browser runs receive a short-lived private temporary directory and complete the
server/browser workflow in one sandbox command so Playwright's daemon and sockets are cleaned up. Private
browser temp directories older than 24 hours are removed before later agent runs. Every visual response
includes a controller-generated artifact manifest, even when the model omits evidence paths from its prose.

## Automatic Docker access

When `PI_WORKER_DOCKER_SOCKET` (default `/var/run/docker.sock`) exists and is accessible, Docker is
available automatically to implementation, review, conflict, and CI-repair runs. Set
`PI_WORKER_ALLOW_DOCKER=0` to disable it explicitly. The worker still blocks common privileged,
host-namespace, device, host-mount, and socket-forwarding flags.

This is **not normal sandboxing**. Docker daemon access can provide host-level control and bypass Sandbox
Runtime filesystem/network boundaries; command filtering is not a security boundary. Run the worker only
on a dedicated disposable machine/account with no unrelated credentials or workloads.

Agent runs have two anti-stall safeguards: a final `agent_settled` event releases a Pi SDK prompt that
fails to settle after a short grace period, and `PI_WORKER_AGENT_TIMEOUT_MINUTES` places a hard ceiling on
runs that never reach a terminal event. The normal controller path then records the final result, clears
partial source changes for `BLOCKED` output, and updates GitHub instead of wedging the repository profile.

## State and recovery

Each profile stores in a collision-resistant repository-specific default directory (explicit
`PI_WORKER_DATA_DIR` values are used unchanged):

```text
PI_WORKER_DATA_DIR/
├── repository/       # trusted control clone; Pi never runs here
├── worktrees/        # one linked worktree per issue
├── sessions/         # persistent Pi JSONL sessions
├── logs/             # compact lifecycle logs
└── state.sqlite      # jobs and processed GitHub event IDs
```

A restart resumes claimed/implementing issues, unprocessed feedback for `addressing_review` jobs, and
interrupted `addressing_ci` repairs in the persistent issue session. CI attempts and handled head SHAs
survive restarts, preventing duplicate repair loops. If a commit was already produced, it is pushed and
used to create the missing PR instead of rerunning implementation. Existing open PRs are rediscovered by
branch name.

## Security model and limitations

- Applying the ready label is the human approval boundary. Do not grant issue-triage rights broadly.
- Issue and review text remains untrusted and is delimited as data in prompts.
- Only configured GitHub author associations can trigger follow-up work.
- Pi bash commands use Anthropic Sandbox Runtime OS isolation (bubblewrap on Linux, sandbox-exec on
  macOS, with platform prerequisites installed). Home-directory and credential reads are denied, writes
  are allow-only, and network access is allowlisted. Initialization failure blocks the run; there is no
  unsandboxed fallback. Executable user/project Pi extensions are disabled; only the worker-owned policy
  extension runs in the controller process.
- The agent policy blocks common GitHub/git mutation, privilege escalation, recursive deletion, secret
  paths, CI workflows, and configured protected paths. The controller checks paths again before commit.
  Explicit `BLOCKED` results are never committed; tracked, untracked, and ignored partial changes are
  cleared while ignored `.qa` evidence is retained.
- Docker is automatically exposed when the configured daemon socket exists. It deliberately weakens the
  sandbox and should be used only on a dedicated disposable worker host; set `PI_WORKER_ALLOW_DOCKER=0`
  where that risk is unacceptable.
- Linux visual runs must permit Unix sockets because Chromium and Playwright require them. This is
  enabled only for explicitly requested visual verification or diagnosed browser CI failures; the sandbox hides the home directory and
  `/tmp` and `/var`, masks unrelated `/run` entries, and exposes only a unique private runtime temp
  subtree plus Sandbox Runtime's network bridge. Linux seccomp cannot filter Unix sockets by path, so a dedicated OS account remains
  important defense in depth.
- Run under a dedicated OS account and dedicated GitHub identity as additional defense in depth.
- Model credentials are used by the controller/Pi host process and are never exposed to sandboxed bash.
  Never approve hostile issues.
- There is no auto-merge, force-push, automatic rebase, or arbitrary attachment upload.
- Review replies are posted to the PR conversation rather than individual inline threads.

## Troubleshooting

Start with the [troubleshooting guide](docs/troubleshooting.md). It covers Linux sandbox prerequisites,
AppArmor user namespaces, systemd `PATH` and write permissions, authentication, profile collisions,
restart loops, queue diagnostics, persistent sessions, and safe updates.

Quick service diagnostics:

```bash
systemctl --user status pi-issue-worker-supervisor.service --no-pager
journalctl --user -u pi-issue-worker-supervisor.service --since '-30 minutes' --no-pager
```

Do not print profile contents when collecting diagnostics because a mode-0600 profile may contain
`GH_TOKEN`.

## Development

```bash
npm run build
npm test
npm run check
```

The core is repository-neutral. Repository behavior comes from environment profiles, the target
repository's context files, labels, and configurable protected paths.
