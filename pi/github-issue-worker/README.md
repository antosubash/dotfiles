# Headless Pi GitHub issue worker

A reusable, single-repository worker that turns explicitly approved GitHub issues into isolated Pi
coding sessions and draft pull requests. Run multiple systemd instances to serve multiple repositories.

The worker deliberately does **not** auto-merge. GitHub labels, comments, pushes, commits, and PR
creation belong to the controller. Pi edits and verifies code inside an issue-specific linked worktree.

## Lifecycle

1. A maintainer applies `pi-ready` to an open issue.
2. The worker changes it to `pi-working`, fetches the configured base branch, and creates
   `pi/issue-<number>-<slug>` in a dedicated control clone.
3. Pi loads that repository's `AGENTS.md`, project Pi resources, and normal user resources. It works in
   a persistent issue session and may edit, test, and capture ignored evidence, but policy hooks block
   GitHub CLI use, git mutation, secret paths, CI workflows, and configured protected paths.
4. The controller validates the changed path set, commits, pushes, and opens a **draft** PR with
   `Closes #<number>`.
5. Trusted formal reviews and inline review comments are sent back to the same Pi session. PR
   conversation comments require an explicit `/pi` command.
6. Every event is persisted in SQLite, making comment handling idempotent across restarts.

One process handles work sequentially. This is intentional: repositories with integration databases,
browser sessions, or expensive builds should not be fanned out accidentally.

## Requirements

- Node.js 24 or newer (`node:sqlite` is used)
- Git and GitHub CLI (`gh`), authenticated for the target repository
- Pi authentication in `~/.pi/agent` or `PI_CODING_AGENT_DIR`
- `playwright-cli` for visual evidence
- `ffmpeg` for optional GIF conversion
- A dedicated GitHub App or machine-user identity is strongly recommended

The GitHub identity needs repository contents, issues, and pull-request write access. If the worker uses
your personal `gh` login, its branches, comments, and PRs appear as you.

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
PI_WORKER_THINKING_LEVEL=high
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

## Run as a user service

```bash
mkdir -p ~/.config/systemd/user
cp systemd/pi-issue-worker@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-issue-worker@widgets.service
journalctl --user -u pi-issue-worker@widgets.service -f
```

The supplied hardened unit permits writes under `~/.local/share/pi-issue-worker`. If a profile sets a
different data directory, add that directory to `ReadWritePaths` in a systemd override.

To serve another repository, create `~/.config/pi-issue-worker/blog.env` with its repository and base
branch, then start `pi-issue-worker@blog.service`. State, sessions, clones, and worktrees are separated
by each profile's `PI_WORKER_DATA_DIR`.

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

The controller adds `/.qa/` to its private control clone's Git exclude and never stages it. GitHub CLI
cannot attach local images to PR comments, so comments contain text summaries and local evidence paths;
a maintainer may manually attach selected files. Old timestamped runs are removed after
`PI_WORKER_QA_RETENTION_DAYS`.

Pi uses a unique `playwright-cli` session, takes an accessibility snapshot before interaction, checks
console/network failures, and closes the browser session. GIF requests record WebM and use `ffmpeg` for
conversion.

## State and recovery

Each profile stores:

```text
PI_WORKER_DATA_DIR/
├── repository/       # trusted control clone; Pi never runs here
├── worktrees/        # one linked worktree per issue
├── sessions/         # persistent Pi JSONL sessions
├── logs/             # compact lifecycle logs
└── state.sqlite      # jobs and processed GitHub event IDs
```

A restart resumes claimed/implementing issues. If a commit was already produced, it is pushed and used
to create the missing PR instead of rerunning implementation. Existing open PRs are rediscovered by
branch name.

## Security model and limitations

- Applying the ready label is the human approval boundary. Do not grant issue-triage rights broadly.
- Issue and review text remains untrusted and is delimited as data in prompts.
- Only configured GitHub author associations can trigger follow-up work.
- The agent policy blocks common GitHub/git mutation, privilege escalation, recursive deletion, secret
  paths, CI workflows, and configured controller paths. The controller checks paths again before commit.
- Run under a dedicated OS account, dedicated GitHub identity, and sandbox/container for stronger
  isolation. Prompt/tool guards are defense in depth, not a complete sandbox: an unrestricted coding
  shell and network access cannot safely process hostile content by policy alone.
- Model credentials necessarily remain available to Pi. Never approve hostile issues.
- There is no auto-merge, force-push, automatic rebase, or arbitrary attachment upload.
- Review replies are posted to the PR conversation rather than individual inline threads.

## Development

```bash
npm run build
npm test
npm run check
```

The core is repository-neutral. Repository behavior comes from environment profiles, the target
repository's `AGENTS.md`/Pi resources, labels, and configurable protected paths.
