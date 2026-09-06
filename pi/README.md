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

Subagent capture separates JSON transport from retained results: **64 MiB stdout**,
**16 MiB per JSON line**, **8 MiB retained transcript**, and **256 KiB stderr** per
invocation. Only completed messages are retained; progress deltas and duplicate
turn/agent snapshots do not consume the transcript budget. This replaces the old
256 KiB whole-stream cap that frequently killed ordinary multi-file reviews.
Split UTF-8 characters and the last record without a newline are handled correctly.
Exceeding any limit still terminates the whole child process tree and returns an
explicit failed result naming the exhausted budget. Parallel result display remains
capped at 50 KiB per task. Run `scripts/tests/test-pi-subagent-capture.sh` and
`scripts/tests/test-pi-runtime.sh` for parser and offline subprocess regression tests.
`scripts/tests/test-line-cap.sh` fails if any Pi source or test file exceeds 300 lines.

The extension maps Claude model tiers when loading shared agents:

| Claude tier | Pi model |
|---|---|
| Haiku | `openai-codex/gpt-5.6-luna` |
| Sonnet | `openai-codex/gpt-5.6-terra` |
| Opus | `openai-codex/gpt-5.6-sol` |
| Fable | `openai-codex/gpt-6-astra` |

Pi-specific `scout`, `planner`, `worker`, `reviewer`, `reviewer-fast`, and `browser-qa` agents live beside the shared specialists. `/ship` uses the full Terra reviewer once, then the Luna reviewer only for known findings and fix/QA deltas. P2/P3 advisories are reported without extending the blocking loop.

### Spark for fast reconnaissance

The default interactive model remains GPT-6 Astra. The read-only `scout` agent uses
`openai-codex/gpt-5.3-codex-spark` for focused repository reconnaissance. Planner,
worker, reviewer, and browser QA remain on Terra; `reviewer-fast` and Haiku aliases
remain on Luna. Spark is text-only with a 128K context window: keep screenshot QA
and broad implementation/review work on the existing models.

Spark is also in `enabledModels` with medium thinking for model cycling. To try it
interactively, use `/model openai-codex/gpt-5.3-codex-spark`. Scout's explicit model
pin does not change the parent session's model. No headless issue-worker profile
is changed by this configuration.

## Subscription usage footer

The `usage-status` extension adds a compact line to Pi's existing footer in interactive
OpenAI Codex sessions, leaving the model, context, costs, and other extension statuses intact:

```text
Codex used · 5h ██░░░ 35% ↻2h15m · wk █░░░░ 11% ↻1d20h
```

Percentages are **used**, not remaining. Bars turn yellow at 70% and red at 90%.
The extension reads ChatGPT's usage endpoint with Pi's resolved Codex login. It shows
`Codex used` for the main allowance, or `Spark used` with the separate Spark 5-hour
and weekly allowances when `gpt-5.3-codex-spark` is selected. Switching models clears
the old reading and fetches the correct allowance; it never falls back to main
quota when Spark data is absent. It polls once a minute and updates reset countdowns every
15 seconds; `/usage-refresh` requests an immediate refresh. It never stores tokens or
usage responses in session history or logs, and does not poll in worker/subagent,
print, JSON, or RPC runs.

Some plans return only a weekly window (even as the primary window): `5h n/a` means
not reported, **not** unlimited or 0% used. Review and unrelated model-specific
allowances are never substituted for the selected allowance. Missing/failed data is shown as
`unavailable`, or `stale` if there is a previous reading. Past reset times show
`reset pending` until refreshed. The endpoint is unofficial and may change.

Run `scripts/tests/test-pi-usage-status.sh` for offline parser and lifecycle checks.
After setup, use `/reload` in an existing Pi session to load the extension.

## Context and auto-compaction

The `context-policy` extension checks for **80% of the selected model's registered
context window** at idle session start, idle model switches, after tasks settle,
and before new prompts. It waits for any in-progress policy compaction before
accepting a new prompt, and honors `compaction.enabled` in global/trusted project
settings. `/context-policy` shows the current window and trigger threshold.

Current Codex catalog values:

| Model | Registered window | 80% threshold |
|---|---:|---:|
| GPT-6 Astra / GPT-5.6 Sol, Terra, Luna | 272,000 | 217,600 |
| Codex Spark | 128,000 | 102,400 |

**Safe-boundary limitation:** Pi's public `ctx.compact()` aborts active agent runs;
it is not an automatic between-tool-turn compaction request. This extension never
calls it during an active run or queued continuation. A long task can therefore
pass 80% before settling. Pi's native automatic threshold/overflow compaction
remains enabled with its normal 16,384-token reserve as a fallback; it can compact
and resume within a long run. The extension does not monkey-patch Pi internals.

The model's registered window is never reduced to implement the 80% trigger.
Thresholds automatically follow model switches and supported catalog/`models.json`
window changes. No speculative large-window override is installed: the 1.05M
window documented for direct OpenAI API models is not verified for this Codex
backend. A catalog default is not necessarily the provider's maximum possible
window; only raise it after confirming backend support (and long-context costs).

Run `scripts/tests/test-pi-context-policy.sh` for offline lifecycle checks.

## Loop state

Long workflows persist authoritative state outside the tracked tree in atomically claimed, unique run directories under `$(git rev-parse --path-format=absolute --git-common-dir)`. Common-directory storage survives linked-worktree cleanup and provides repository-wide locks:

- QA: `<git-common-dir>/pi-qa/<qa-run-id>/`
- Verification: `<git-common-dir>/pi-verify/<vf-run-id>/`
- Ship: `<git-common-dir>/pi-ship/<ship-run-id>/`

Exact IDs and absolute paths are threaded through state, reports, sessions, and owned PIDs; passed-QA verification requires its explicit QA run ID and never consults a latest-run pointer. Setup and PR creation also use atomic local locks. If a lock or run claim remains after a crash, verify its owner PID and active processes before removing it. This lets workflows recover after context compaction without relying on conversation prose.

## Safety

`destructive-command-approval.ts` asks before recognizable destructive shell commands
in interactive sessions. It checks command positions rather than matching dangerous
words anywhere in a string: searches, printed examples, comments, and literal
non-shell heredocs no longer trigger approval merely for mentioning `rm -rf` or
`DROP TABLE`.

Routine operations also avoid approval: Git clean **dry-runs**, read-only
`sudo systemctl` status/show/list queries, non-mutating `sudo journalctl`, selected
read-only `sudo docker` queries, and graceful `pkill -x` with a simple literal process
name. Unclassified privileged commands still require approval.

Recursive deletion (including build/temp cleanup), Git discard/force-push, disk
writes, database deletion through recognized SQL clients, infrastructure destruction,
Docker prune/forced container removal, and force/broad process termination remain
protected. Explicit shell payloads, substitutions, common command wrappers, and
piped shell execution are checked too. Approvals are not cached: each destructive
invocation still asks. In print/JSON subagents the same risky commands remain blocked
because no interactive approval UI exists.

This is a **best-effort guard, not a shell interpreter or sandbox**. Aliases, dynamically
assembled commands, external scripts, and arbitrary Python/other interpreter code
are not fully analyzed. Continue running untrusted projects in an isolated environment.
Run `scripts/tests/test-pi-command-risks.sh` for classifier regression tests; the
fixtures never execute the destructive commands.

Project-local Pi resources retain Pi's normal trust prompt (`defaultProjectTrust: ask`).

## Headless GitHub issue worker

`github-issue-worker/` is a repository-neutral Node.js service built on the Pi SDK. It picks up issues
only after a maintainer applies the configured ready label, works in a fresh isolated worktree, opens a
draft PR, monitors its checks with bounded automatic CI repair, and continues trusted review feedback
in the same persistent Pi session. Each child and
environment profile serves one repository. The optional `pi-issue-worker-supervisor` runs multiple
profile-isolated children while preserving separate processes, state, clones, worktrees, and sessions.

Install the CLI and unit template without starting a profile:

```bash
~/dotfiles/scripts/setup-pi-issue-worker.sh
```

See [`github-issue-worker/README.md`](github-issue-worker/README.md) for the overview,
[`docs/installation.md`](github-issue-worker/docs/installation.md) for production setup, and
[`docs/troubleshooting.md`](github-issue-worker/docs/troubleshooting.md) for sandbox, systemd,
authentication, queue, and recovery diagnostics.

## Updating the vendored subagent

The implementation came from Pi's `examples/extensions/subagent/`. After upgrading Pi, compare the installed example with `pi/agent/extensions/subagent/`, carry forward the Claude model alias mapping in `agents.ts`, then run a delegated scout smoke test. The vendored copy is split into `index.ts` (tool registration), `run.ts`/`process.ts` (child lifecycle), `execute.ts`/`chain.ts`/`parallel.ts` (modes), `render-*.ts` (TUI), `schema.ts`, `limits.ts`, `format.ts`, and `results.ts`; diff each against the corresponding region of upstream `index.ts`.
