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

// IIASA.GeoWiki#501, tenth attempt: the independent verifier passed after 45 minutes, and 37 seconds later
// the GitHub token expired. The merge-context check threw a transport error, the catch path treated it like
// a failed verification — abort, discard, block — and the verified resolution was gone. A GitHub outage
// after verification must keep the staged merge in place so the next tick can resume and finish it.
// The push comes before verification now, so the merge-context read is the last GitHub call that can fail
// with the resolution still local. A transport failure there keeps the staged merge; nothing is aborted.
test("a GitHub transport failure before the push keeps the staged merge for the next tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-transport-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  const order: string[] = [];
  let githubDown = false;
  let mergeInProgress = false;
  const mergeState = { headSha: "feature-head", baseSha: "base-head", baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => { if (githubDown) throw new Error("gh pr view 77 failed (1): 401 Unauthorized"); return mergeState; },
    markPullRequestOpen: async () => { if (githubDown) throw new Error("401"); },
    commentPullRequest: async (_pr: number, body: string) => { if (githubDown) throw new Error("401"); order.push(`comment:${body.slice(0, 30)}`); },
    markBlocked: async () => { order.push("blocked"); },
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    hasMergeInProgress: async () => mergeInProgress,
    beginBaseMerge: async () => {
      order.push(mergeInProgress ? "merge-resumed" : "merge-begun");
      const conflicts = mergeInProgress ? [] : ["src/form.ts"];
      mergeInProgress = true;
      return { baseSha: "base-head", conflicts, alreadyCurrent: false, mergeInProgress: true };
    },
    // The token dies right after the FIRST staging, before the merge-context read; tick 2 sees a healthy GitHub.
    stageBaseMerge: async () => { order.push("staged"); if (order.filter((e) => e === "staged").length === 1) githubDown = true; },
    finishBaseMerge: async () => { order.push("committed"); mergeInProgress = false; },
    abortBaseMerge: async () => { order.push("aborted"); mergeInProgress = false; },
    clearAgentChanges: async () => { order.push("discarded"); },
  };
  const agent = { run: async () => { order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
      qaVerifier: { verify: async () => { order.push("verified"); return "/private/qa/result.json"; } },
    });
    // Tick 1: staged, then every GitHub call fails. Nothing may be aborted, discarded or verified.
    await assert.rejects(worker.tick(), /401/);
    assert.deepEqual(order, ["merge-begun", "resolved", "staged"]);
    assert.equal(mergeInProgress, true);
    assert.match(state.getJob(42)?.lastError ?? "", /GitHub/);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), false);
    // Tick 2: GitHub is back. The in-progress merge resumes, is committed and pushed, then verified.
    githubDown = false;
    await worker.tick();
    assert.deepEqual(order.slice(3, 6), ["merge-resumed", "staged", "committed"]);
    assert.match(order[6] ?? "", /^comment:🔀 Updated the feature branch/);
    assert.equal(order[7], "verified");
    assert.match(order[8] ?? "", /^comment:✅ Post-resolution verific/);
    assert.equal(order.length, 9);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A conflict block is keyed on the PR's head and base OIDs, and GitHub's baseRefOid only moves when the PR
// syncs — so once processed, the resolution never re-ran and the documented `/pi retry` only knew about CI
// blocks. Retrying a conflict block must re-queue the resolution (next tick), not send the agent "retry".
test("trusted /pi retry on a conflict-blocked PR re-queues the base-branch resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-retry-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.setStatus(42, "pr_open", "Automatic base-branch conflict resolution failed: Independent QA gate: fixture");
  state.markProcessed(42, "merge-conflict:77:main:feature-head:base-head");
  const order: string[] = [];
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "feature-head", baseSha: "base-head", baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async (_pr: number, body: string) => { order.push(`comment:${body.slice(0, 40)}`); },
    markBlocked: async () => undefined,
    listFeedback: async () => [{
      eventKey: "conversation:retry-conflict", source: "conversation", id: 11, body: "/pi retry", author: "maintainer",
      authorAssociation: "MEMBER", createdAt: "2026-01-02T00:00:00Z", url: null,
    }],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    beginBaseMerge: async () => { order.push("merge-begun"); return { baseSha: "base-head", conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true }; },
    stageBaseMerge: async () => undefined,
    finishBaseMerge: async () => { order.push("committed"); },
    abortBaseMerge: async () => undefined,
    clearAgentChanges: async () => undefined,
  };
  const agent = { run: async () => { order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(order.length, 1);
    assert.match(order[0]!, /^comment:🔄 Base-branch conflict resolution retry/);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), false);
    assert.equal(state.hasProcessed("conversation:retry-conflict"), true);
    await worker.tick();
    assert.deepEqual(order.slice(1, 4), ["merge-begun", "resolved", "committed"]);
    assert.match(order[4] ?? "", /^comment:🔀 Base-branch conflicts resolved/);
    assert.match(order[5] ?? "", /^comment:✅ Post-resolution verification/);
    assert.equal(order.length, 6);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
