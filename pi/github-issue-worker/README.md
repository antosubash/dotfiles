# Headless Pi GitHub issue worker

A reusable GitHub issue and pull-request worker that turns explicitly approved issues into isolated Pi coding sessions
and draft pull requests, and adopts existing pull requests that carry the ready label. Each worker child remains bound to one repository; the optional supervisor runs
multiple profile-isolated children from one installation.

The worker deliberately does **not** auto-merge. GitHub labels, comments, pushes, commits, and PR
creation belong to the controller. Pi implements inside an issue-specific linked worktree; fresh independent
QA and design-verification sessions evaluate its output before the controller can ship it.

## Lifecycle

1. A maintainer applies `pi-ready` to an open issue.
2. The worker changes it to `pi-working`, fetches the configured base branch, and creates
   `pi/issue-<number>-<slug>` in a dedicated control clone.
3. Pi loads repository context files and safe non-executable resources. User and project executable
   extensions are disabled because they run in the controller process outside the tool sandbox. Pi works
   in a persistent issue session and may edit, test, and capture ignored evidence, but policy hooks block
   GitHub CLI use, git mutation, secret paths, CI workflows, and configured protected paths.
4. A separate QA session verifies acceptance, regressions, and relevant negative cases using actual checks
   (plus fresh browser evidence for UI). If the issue contains Figma links, another separate session compares
   every linked frame against the implementation. Missing/failed evidence blocks shipping. The controller
   then validates the changed path set, commits, pushes, and opens a **draft** PR with
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
8. A maintainer may instead apply `pi-ready` directly to an existing same-repository PR targeting the configured base. The worker checks out that exact remote head in `worktrees/pr-<number>`, adopts its trusted `/pi` feedback, conflicts, and CI without opening another PR. Fork PRs and alternate bases fail closed.
9. Every review, conflicting head/base pair, and CI-head event is persisted in SQLite, making handling
   idempotent across restarts. After GitHub reports a tracked PR as merged, the cleanup service removes its clean managed worktree once every local commit is contained in the merged PR head (fetched from `refs/pull/<n>/head`, which survives squash merges and branch deletion); closed-unmerged PRs and dirty or diverged worktrees are preserved.

Each repository child handles its work sequentially. This is intentional: repositories with integration
databases, browser sessions, or expensive builds should not be fanned out accidentally. A per-profile
`worker.lock` is acquired before SQLite opens; a concurrent instance exits with the owning PID. Different
profiles may run concurrently under the supervisor while retaining separate state and process boundaries.

## Optional pi-plan and independent acceptance gates

Planning is **opt-in**. Apply the `pi-plan` label to an issue to create only an implementation plan and a
verification checklist. The planner has only read/grep/find/ls tools: it cannot implement, run tests/servers,
commit, push, or open a PR. The controller creates/preserves an isolated worktree for reconnaissance, stores
`<data-dir>/plans/issue-<number>.json`, and comments the plan on the issue. Both `pi-plan` and any simultaneous
`pi-ready` label are removed; review the plan, then explicitly apply `pi-ready` to start implementation.
Requesting planning on an active job pauses it without editing source; inspect it and request planning again.
A blocked plan does not start implementation. Reapply `pi-plan` after clarifying its blocker.

Each checklist entry has a stable `P1`/`P2` ID, `behavioral` or `design` kind, requirement, reproducible steps,
and expected result. The implementation worker receives the saved plan. Independent QA verifies every
behavioral entry; the separate Figma verifier verifies every design entry. Both also check the original issue.
An edited issue title/body makes an existing plan stale and blocks implementation/verification until replanned.
Labels and timestamps do not invalidate plans. With **no plan requested**, the normal acceptance/regression QA
flow runs; planning is not an automatic prerequisite. Interactive Pi has the equivalent `/pi-plan` prompt,
`issue-verifier` and `design-verifier` agents, and `issue-qa` / `figma-verify` orchestration skills.

**No Figma link does not mean no QA.** Every implementation, review/CI fix, merge update, and interrupted
push recovery passes a fresh independent QA session. Non-UI work runs meaningful repository-native checks
without requiring a browser. UI work requires actual changed-surface interactions and desktop/mobile PNGs.
The implementer's claims or existing media never substitute for independent evidence. Verifier write/edit
tools are restricted to private evidence, and Docker commands are policy-blocked for verifiers (the
implementation worker retains its configured Docker policy). With OS sandboxing on (see
[Sandboxing](#sandboxing)) verifier source is additionally OS-read-only and tests/builds must use documented
flags to put outputs/caches in private scratch space; with it off, build outputs land in their normal ignored
locations and the verifier is expected to start the repository's documented stack rather than report an
unstarted backend as a blocker. In both modes the controller hashes HEAD, index, tracked contents, and
nonignored untracked contents before/after each verifier and rejects mutation. Every QA command claimed must
be contained in a successful runner-recorded tool execution (whitespace and `;`/newline layout may differ —
separators inside quotes are data, not statement boundaries — and
a claim may leave out trailing exit-status bookkeeping, but never a trailing command and never anything that
did not run). This proves a command was invoked and that its run exited zero — not that the check it performed
passed: a run wrapped in status bookkeeping exits zero whatever the wrapped command did, and the verdict's own
reported status carries that claim. Browser evidence requires screenshot-command and image-read receipts. A
verdict that describes a passing run but is malformed — invalid JSON, an unmatched command receipt, a
misnamed log — gets exactly one repair turn in the same verifier session and is re-validated against the
original run's receipts; evidence files are fingerprinted across the repair turn and any change to them
rejects the verdict outright, with no further repair. Failed or blocked verdicts are never sent back. These are LLM-assisted
behavioral/visual assessments, not mathematical proof of design equivalence.

Figma links in issue title/body (including Markdown, bare links, `/file`, `/design`, `/proto`, `/board`, and
branch links) are canonicalized and deduplicated by file/node, ignoring tracking parameters. Exact HTTPS
Figma hosts only; Make, file-only/ambiguous links, invalid nodes, or more than ten selected frames block the
gate. Supply explicit `node-id` frame links. The controller invokes the **operator-installed**
`<agent-dir>/skills/figma/scripts/figma.py`, never a CLI from the untrusted issue checkout. Install the Figma
skill and Python 3.10+ on the worker host, and configure a private token with `file_content:read` for the
service user using the skill's setup guide. No token is copied to issue worktrees; exported Figma credentials
are scrubbed from ALL agent sessions and only the controller-owned CLI gets them. The supervisor needs no
separate setting: each repository child runs its own gates and private storage.

Design bundles are cached under `<data-dir>/figma/issue-<number>/designs/`, pinned to their recorded version,
and reused across fixes. Fresh independent sessions/screenshots/verdicts are created for each verification.
No automatic API retry, including 429; report Retry-After and require operator action. To deliberately refresh
a changed design or retry an incomplete bundle, stop the profile, inspect/archive the affected private cache
entry, then explicitly retry. Never reuse an incomplete manifest or a PASS after source changes.

QA reports/logs live under `<data-dir>/verification/issue-<number>/`; design reports/bundles under
`<data-dir>/figma/issue-<number>/`; planning sessions under `<data-dir>/planning/`. These are private local
artifacts, separate from the implementation session and ordinary published `.qa` media. Design bundles and
verifier screenshots are **not automatically uploaded or committed**. Review `result.json` and `verdict.txt`
for failed checks. Failed/blocked/partial verification stops the headless flow for human action and explicit
retry; the verifiers never patch source. Interactive orchestration can return concrete findings to `worker`
within its bounded fix loop, always followed by fresh verification.

## Requirements

- Node.js 24 or newer (`node:sqlite` is used)
- Git and GitHub CLI (`gh`), authenticated for the target repository
- Pi authentication in `~/.pi/agent` or `PI_CODING_AGENT_DIR`
- `playwright-cli` for visual evidence
- `ffmpeg` for optional GIF conversion
- Only with `PI_WORKER_SANDBOX=1`: Anthropic Sandbox Runtime prerequisites — on Linux, `bubblewrap`, `socat`, and `ripgrep`; macOS requires `ripgrep`. The worker then fails closed if the OS sandbox cannot initialize.
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
# OS sandboxing of agent bash commands. Off (0) by default for now — see "Sandboxing" below.
PI_WORKER_SANDBOX=0
# Optional additional hosts for sandboxed build/browser verification (comma-separated; PI_WORKER_SANDBOX=1 only)
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

- `pi-plan` — fixed, opt-in planning-only label; review its output before separately applying `pi-ready`
- `pi-ready` — maintainer approval and queue entry
- `pi-working` — claimed
- `pi-pr-open` — draft PR created
- `pi-blocked` — human help required
- `pi-visual` — request local browser evidence

When the worker opens or rediscovers a pull request for an issue, it also labels the PR itself.
The PR receives `pi-pr-open` plus the issue's non-transient labels (for example `bug`, area,
priority, and `pi-visual`). For issue-created PRs, queue/lifecycle labels `pi-ready`, `pi-working`, and `pi-blocked`
remain on the source issue only. An existing PR explicitly submitted with `pi-ready` uses those labels on the PR itself while it is adopted, then receives `pi-pr-open`. Label synchronization is idempotent and retried before the
controller records the PR as open. On upgrade, tracked open worker PRs receive the same one-time
label backfill.

## Run one profile as a user service

```bash
mkdir -p ~/.config/systemd/user
cp systemd/pi-issue-worker@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-issue-worker@widgets.service
journalctl --user -u pi-issue-worker@widgets.service -f
```

The supplied units permit controller writes under `~/.local/share/pi-issue-worker`,
`~/.cache`, `~/.pi/agent` (the Pi SDK locks and may refresh its auth state), the private user runtime
root used for visual browser sockets, and — because agent commands run under the same unit when
sandboxing is off — the toolchain homes `~/.nuget`, `~/.aspire`, `~/.dotnet`, `~/.dcp` (the Aspire orchestrator's port allocation state), `~/.microsoft` (user secrets), `~/.aspnet` (data-protection keys), `~/.local/share/pnpm`, and
`~/.npm`. If a profile sets a different data directory, or a repository's toolchain writes elsewhere under
`$HOME` (`~/.cargo`, `~/go`, …), add that directory to `ReadWritePaths` in a systemd override. With
`PI_WORKER_SANDBOX=1`, Pi bash commands additionally run inside Anthropic Sandbox Runtime: reads are
denied across the home directory except the issue worktree and required Git metadata, writes are limited
to the worktree and temporary build space, and network access uses an allowlist. Add project-specific
browser/build hosts with `PI_WORKER_SANDBOX_ALLOWED_DOMAINS`; do not put credentials or broad wildcards
there.

## Sandboxing

`PI_WORKER_SANDBOX` decides whether agent bash commands run inside the Anthropic Sandbox Runtime
(bubblewrap on Linux). **It is off by default for now.** The OS sandbox isolates every command in its own
network namespace and hides `$HOME`, which makes the stacks agents must actually run unstartable: host
dev services (a shared Postgres/Redis/MinIO on loopback) are unreachable without a Docker bridge that
verifiers may never use, and toolchain caches such as `~/.nuget/packages` are invisible, so a .NET
backend cannot even be restored. Sandboxing returns as the default once the stack-launch story works
inside it; until then set `PI_WORKER_SANDBOX=1` per profile to opt back in.

What is enforced in both modes:

- the agent policy: `gh`, git mutation, `sudo`, recursive deletion, secret files, CI workflows, protected
  paths, Docker without an explicit grant, and any reference to a credential store under `$HOME` (Pi
  agent directory, worker profiles, SSH/AWS/GPG/netrc/npm/Docker credentials) are blocked at the
  tool-call level — a textual rule, so treat it as a tripwire rather than a wall;
- the verifier may write only its private evidence directory, and its source is fingerprinted before and
  after the run — any mutation invalidates the verdict;
- credential-looking environment variables (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, …) are stripped from
  every agent command, and the worker's own GitHub/Figma tokens are removed from the process for the
  duration of a run;
- every bash call is a detached process group that the controller terminates when the call ends, so app
  servers and browsers must be started, exercised, and stopped within one call.

What is *not* enforced with sandboxing off: `$HOME` is readable, the network is open, and loopback ports
are shared with the host and with other worker runs. The prompts tell agents to use the repository's
documented isolated launcher with run-unique instance names (databases, cache prefixes, ports), and that a
backend which is merely not running is a launch task rather than a blocker. Run the worker under a
dedicated OS account and treat the host as disposable while sandboxing is off.

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
Ordinary PR conversation text is ignored unless it starts with `/pi`. To bootstrap a PR that the worker did not create, apply `pi-ready` to that same-repository PR; the label is the explicit adoption authorization, while `/pi` supplies the requested action. Worker-authored comments carry a
hidden marker and are ignored, preventing feedback loops. A trusted `/pi retry` comment posted on a
blocked issue is also processed automatically: the controller reclaims the existing worktree/session and
updates labels without requiring a separate `pi-ready` edit. On a PR blocked by a failed base-branch
conflict resolution, `/pi retry` re-queues that resolution for the next poll (a conflict block is keyed on
the PR's head and base commits and would otherwise never re-run); on a PR blocked by CI repair it re-opens
the failed head. Commands older than the latest blocked state are ignored.

## Repository QA manifest

Repositories may provide a strict, read-only `.pi-worker/qa.json` manifest (override with
`PI_WORKER_QA_MANIFEST`). Version 1 can name the Aspire AppHost/resources, truthful preview routes, and
validation commands represented as argument arrays rather than shell strings. The worker uses this trusted
metadata to classify the least expensive truthful workflow, perform a PNG capability preflight before UI
implementation, resolve Aspire runtime URLs, and avoid rediscovering commands on every issue.

The controller rejects oversized, malformed, unknown-key, traversal, absolute-path, and symlinked
manifests. `.pi-worker` is protected from agent writes by default. Component previews may use representative
props only when they import the exact production component, configuration, and styles; preview-only markup,
CSS, or expected geometry is false evidence.

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
inside a credential-free networkless media sandbox, enforces per-file and per-run size limits (a PNG
screenshot over the limit fails the run; a workflow GIF/WebM over it is omitted and noted in the PR comment,
as is a GIF that was never produced), publishes
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
├── worktrees/        # issue-<n> and adopted pr-<n> linked worktrees
├── sessions/         # persistent Pi JSONL sessions
├── logs/             # compact lifecycle logs
└── state.sqlite      # jobs and processed GitHub event IDs
```

A restart resumes claimed/implementing issues, adopted pull requests, unprocessed feedback for `addressing_review` jobs, and
interrupted `addressing_ci` repairs in the persistent session. A poll-time cleanup service removes managed worktrees only after the associated PR is merged and only when the worktree is registered, clean, and holds no commit the merged PR head does not contain (a remote "Update branch" merge may leave the local branch behind the merged head; that is still safe to remove); cleanup failures remain retryable in SQLite. CI attempts and handled head SHAs
survive restarts, preventing duplicate repair loops. Evidence runs have persistent `pending`, `valid`,
`published`, `blocked`, and `invalid-terminal` states; failed historical captures are terminal and cannot
poison a later successful PR or be retried on every poll. Runner/startup failures and isolated test timeouts
are rerun once without spending an agent repair attempt; repeated or real assertion failures follow the
normal bounded diagnosis path. If a commit was already produced, it is pushed and
used to create the missing PR instead of rerunning implementation. Existing open PRs are rediscovered by branch name. Before implementation, the controller also rejects an
open PR on another branch that already references the same issue, preventing overlapping worker and grouped
feature PRs.

## Security model and limitations

- Applying the ready label is the human approval boundary. Do not grant issue-triage rights broadly.
- Issue and review text remains untrusted and is delimited as data in prompts.
- Only configured GitHub author associations can trigger follow-up work.
- With `PI_WORKER_SANDBOX=1`, Pi bash commands use Anthropic Sandbox Runtime OS isolation (bubblewrap on
  Linux, sandbox-exec on macOS, with platform prerequisites installed). Home-directory and credential reads
  are denied, writes are allow-only, and network access is allowlisted. Initialization failure blocks the
  run; there is no silent unsandboxed fallback. **The default is currently `0`** — see
  [Sandboxing](#sandboxing) for what remains enforced. Executable user/project Pi extensions are disabled
  in both modes; only the worker-owned policy extension runs in the controller process.
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
- Model credentials are used by the controller/Pi host process and are never exposed to agent bash:
  credential-looking environment variables are stripped from every command in both modes, and bash
  commands that reference credential stores (the Pi agent directory, `~/.config/pi-issue-worker`, `~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`) are policy-blocked. That textual
  rule is the only guard on those paths while sandboxing is off. Never approve hostile issues.
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
