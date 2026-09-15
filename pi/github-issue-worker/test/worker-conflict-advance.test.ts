import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

function conflictState(headSha: string, baseSha: string) {
  return { headSha, baseSha, baseBranch: "main", mergeable: "CONFLICTING" as const, mergeStateStatus: "DIRTY" };
}

test("a recovered B1 merge leaves the advanced B2 event for a fresh resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-recovered-base-advance-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let localHead = "merge-b1";
  let prHead = "feature-head";
  let agentRuns = 0;
  const recoveredEvent = "merge-conflict:77:main:feature-head:base-b2";
  const freshEvent = "merge-conflict:77:main:merge-b1:base-b2";
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => conflictState(prHead, "base-b2"),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: prHead, state: "pending" as const, failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => localHead,
    hasMergeInProgress: async () => false,
    recoverBaseMergePush: async () => false,
    beginBaseMerge: async () => ({ baseSha: "base-b2", conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true, staleMerge: false }),
    stageBaseMerge: async () => undefined,
    finishBaseMerge: async () => { localHead = "merge-b2"; },
    abortBaseMerge: async () => undefined,
    clearAgentChanges: async () => undefined,
  };
  const agent = { run: async () => { agentRuns += 1; return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(state.hasProcessed(recoveredEvent), false);
    assert.equal(agentRuns, 0);
    prHead = "merge-b1";
    await worker.tick();
    assert.equal(agentRuns, 1);
    assert.equal(state.hasProcessed(freshEvent), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale staged B1 merge is discarded and B2 is attempted on the next tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-staged-base-advance-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let base = "base-b1";
  let mergeInProgress = false;
  let agentRuns = 0;
  const order: string[] = [];
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => conflictState("feature-head", base),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending" as const, failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    hasMergeInProgress: async () => mergeInProgress,
    beginBaseMerge: async () => {
      if (mergeInProgress && base === "base-b2") {
        mergeInProgress = false;
        order.push("discard-stale-b1");
        return { baseSha: base, conflicts: [], alreadyCurrent: false, mergeInProgress: false, staleMerge: true };
      }
      mergeInProgress = true;
      order.push(`begin-${base}`);
      return { baseSha: base, conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true, staleMerge: false };
    },
    stageBaseMerge: async () => { order.push("staged"); },
    finishBaseMerge: async () => { mergeInProgress = false; order.push("committed"); },
    abortBaseMerge: async () => undefined,
    clearAgentChanges: async () => { order.push("cleared"); },
  };
  const agent = { run: async () => { agentRuns += 1; order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.deepEqual(order, ["begin-base-b1", "resolved", "staged", "committed"]);
    // Simulate an interrupted staged merge, then a fetched live base advance before the next poll.
    mergeInProgress = true;
    base = "base-b2";
    await worker.tick();
    assert.deepEqual(order.slice(4), ["discard-stale-b1", "cleared"]);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-b2"), false);
    assert.equal(agentRuns, 1);
    await worker.tick();
    assert.deepEqual(order.slice(6), ["begin-base-b2", "resolved", "staged", "committed"]);
    assert.equal(agentRuns, 2);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-b2"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
