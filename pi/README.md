# Pi Development Workflow

Run `~/dotfiles/scripts/setup-pi.sh` to link these resources into `~/.pi/agent/`. Authentication, trust decisions, model catalogs, and sessions remain local and are never linked into this repository.

## Workflows

| Command | Purpose |
|---|---|
| `/worktree` | Create or select the isolated worktree for a task |
| `/implement` | Worktree-first scout → planner → worker chain |
| `/loop` | Worktree-first bounded implement → review → fix convergence |
| `/review` | Read-only reviewer subagent |
| `/qa` | Parallel Playwright CLI testing, isolated fix worktrees, review, retest |
| `/vf` | Gated branch, browser, e2e, local-CI, and PR verification |
| `/ship` | One full review, scoped fix confirmations, optional QA convergence, then exactly one `/vf` PR |
| `/repos-sync` | Safe workspace synchronization |

`/commit`, `/verify`, `/pr`, and `/handoff` provide smaller focused workflows.

## Worktree-first development

Write-capable workflows use linked Git worktrees by default. `/implement`, `/loop`, and `/worktree` fetch and create every new worktree from `origin/<default-branch>`—never current `HEAD` or a local default branch. `/qa`, `/ship`, `/vf`, `/commit`, and `/pr` operate on an existing feature branch, so they require an existing linked worktree rather than silently creating a derived or replacement branch. `--worktree PATH` selects an existing registered worktree; `--no-worktree` is the explicit escape hatch.

A dirty primary checkout is never stashed, copied, auto-committed, or moved. Workflows stop with safe guidance instead. Every agent and project command receives the selected path as `cwd`, and the feature worktree is preserved after completion for inspection or resume. `/qa` may create additional temporary fix worktrees, but removes only those after their commits are safely merged.

## Agents

Pi's vendored subagent extension discovers `~/.pi/agent/agents/*.md` and supports single, parallel, and chained execution. Specialist definitions are relative links to `.claude/agents/`, so Claude and Pi share one source of truth.

The subagent extension enforces a 256 KiB per-invocation capture budget across event output, stderr, and retained messages. Exceeding it terminates the whole child process tree and returns an explicit failed result.

The extension maps Claude model tiers when loading shared agents:

| Claude tier | Pi model |
|---|---|
| Haiku | `openai-codex/gpt-5.4-mini` |
| Sonnet | `openai-codex/gpt-5.6-luna` |
| Opus/Fable | `openai-codex/gpt-5.6-sol` |

Pi-specific `scout`, `planner`, `worker`, `reviewer`, `reviewer-fast`, and `browser-qa` agents live beside the shared specialists. `/ship` uses the full Luna reviewer once, then the Mini reviewer only for known findings and fix/QA deltas. P2/P3 advisories are reported without extending the blocking loop.

## Loop state

Long workflows persist authoritative state outside the tracked tree in atomically claimed, unique run directories under `$(git rev-parse --path-format=absolute --git-common-dir)`. Common-directory storage survives linked-worktree cleanup and provides repository-wide locks:

- QA: `<git-common-dir>/pi-qa/<qa-run-id>/`
- Verification: `<git-common-dir>/pi-verify/<vf-run-id>/`
- Ship: `<git-common-dir>/pi-ship/<ship-run-id>/`

Exact IDs and absolute paths are threaded through state, reports, sessions, and owned PIDs; passed-QA verification requires its explicit QA run ID and never consults a latest-run pointer. Setup and PR creation also use atomic local locks. If a lock or run claim remains after a crash, verify its owner PID and active processes before removing it. This lets workflows recover after context compaction without relying on conversation prose.

## Safety

`destructive-command-approval.ts` asks before recognizable destructive shell commands in interactive sessions. The same commands are blocked in print/JSON subagents because no approval UI exists. This is a best-effort guard, not a sandbox; continue running untrusted projects in an isolated environment.

Project-local Pi resources retain Pi's normal trust prompt (`defaultProjectTrust: ask`).

## Headless GitHub issue worker

`github-issue-worker/` is a repository-neutral Node.js service built on the Pi SDK. It picks up issues
only after a maintainer applies the configured ready label, works in a fresh isolated worktree, opens a
draft PR, and continues trusted review feedback in the same persistent Pi session. One systemd instance
and environment profile serves one repository, so a single installation can safely serve multiple
repositories with separate state.

Install the CLI and unit template without starting a profile:

```bash
~/dotfiles/scripts/setup-pi-issue-worker.sh
```

See [`github-issue-worker/README.md`](github-issue-worker/README.md) for security boundaries, `/pi`
commands, visual evidence, configuration, and service activation.

## Updating the vendored subagent

The implementation came from Pi's `examples/extensions/subagent/`. After upgrading Pi, compare the installed example with `pi/agent/extensions/subagent/`, carry forward the Claude model alias mapping in `agents.ts`, then run a delegated scout smoke test.
