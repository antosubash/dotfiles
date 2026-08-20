# Pi Development Workflow

Run `~/dotfiles/scripts/setup-pi.sh` to link these resources into `~/.pi/agent/`. Authentication, trust decisions, model catalogs, and sessions remain local and are never linked into this repository.

## Workflows

| Command | Purpose |
|---|---|
| `/implement` | Scout → planner → worker chain |
| `/loop` | Bounded implement → review → fix convergence |
| `/review` | Read-only reviewer subagent |
| `/qa` | Parallel Playwright CLI testing, isolated fix worktrees, review, retest |
| `/vf` | Gated branch, browser, e2e, local-CI, and PR verification |
| `/ship` | One full review, scoped fix confirmations, optional QA convergence, then exactly one `/vf` PR |
| `/repos-sync` | Safe workspace synchronization |

`/commit`, `/verify`, `/pr`, and `/handoff` provide smaller focused workflows.

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

Long workflows persist authoritative state outside the tracked tree in atomically claimed, unique run directories:

- QA: `$(git rev-parse --absolute-git-dir)/pi-qa/<qa-run-id>/`
- Verification: `$(git rev-parse --absolute-git-dir)/pi-verify/<vf-run-id>/`
- Ship: `$(git rev-parse --absolute-git-dir)/pi-ship/<ship-run-id>/`

Exact IDs and absolute paths are threaded through state, reports, sessions, and owned PIDs; passed-QA verification requires its explicit QA run ID and never consults a latest-run pointer. Setup and PR creation also use atomic local locks. If a lock or run claim remains after a crash, verify its owner PID and active processes before removing it. This lets workflows recover after context compaction without relying on conversation prose.

## Safety

`destructive-command-approval.ts` asks before recognizable destructive shell commands in interactive sessions. The same commands are blocked in print/JSON subagents because no approval UI exists. This is a best-effort guard, not a sandbox; continue running untrusted projects in an isolated environment.

Project-local Pi resources retain Pi's normal trust prompt (`defaultProjectTrust: ask`).

## Updating the vendored subagent

The implementation came from Pi's `examples/extensions/subagent/`. After upgrading Pi, compare the installed example with `pi/agent/extensions/subagent/`, carry forward the Claude model alias mapping in `agents.ts`, then run a delegated scout smoke test.
