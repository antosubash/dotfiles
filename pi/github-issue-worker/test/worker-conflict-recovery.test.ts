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
test("a GitHub transport failure after verification keeps the staged merge for the next tick", async () => {
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
    stageBaseMerge: async () => { order.push("staged"); },
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
      // The token dies right after the FIRST verification; the second one (tick 2) sees a healthy GitHub.
      qaVerifier: { verify: async () => { order.push("verified"); if (order.filter((e) => e === "verified").length === 1) githubDown = true; return "/private/qa/result.json"; } },
    });
    // Tick 1: verification passes, then every GitHub call fails. Nothing may be aborted or discarded.
    await assert.rejects(worker.tick(), /401/);
    assert.deepEqual(order, ["merge-begun", "resolved", "staged", "verified"]);
    assert.equal(mergeInProgress, true);
    assert.match(state.getJob(42)?.lastError ?? "", /GitHub/);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), false);
    // Tick 2: GitHub is back. The in-progress merge resumes, is re-verified, committed and pushed.
    githubDown = false;
    await worker.tick();
    assert.deepEqual(order.slice(4, 8), ["merge-resumed", "staged", "verified", "committed"]);
    assert.match(order[8] ?? "", /^comment:🔀 Updated the feature branch/);
    assert.equal(order.length, 9);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
