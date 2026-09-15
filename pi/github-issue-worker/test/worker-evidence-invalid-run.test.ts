import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import { config, issue, TestIssueWorker } from "./helpers/worker-fixtures.js";

test("an invalid evidence directory cannot starve PR feedback polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-invalid-evidence-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const worktree = join(root, "worktrees", "pr-88");
  const pullRequest = {
    ...issue, number: 88, url: "https://github.com/example/widgets/pull/88",
    headRefName: "feature/adopt-me", headRefOid: "head-88",
    baseRefName: "main", isCrossRepository: false,
  };
  state.adoptPullRequest(pullRequest, worktree, false);
  const invalid = join(worktree, ".qa/issues/88/pr-88/runs/20260906T173902Z-retry");
  await mkdir(invalid, { recursive: true });
  let polls = 0;
  try {
    const worker = new TestIssueWorker(config(root), state, {
      github: {
        listReadyIssues: async () => [],
        listReadyPullRequests: async () => [],
        isPullRequestOpen: async () => true,
        getPullRequest: async () => pullRequest,
        activatePullRequest: async () => {},
        getPullRequestMergeState: async () => ({
          headSha: "head-88", baseSha: "base", baseBranch: "main",
          mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        }),
        listFeedback: async () => { polls += 1; return []; },
        getPullRequestChecks: async () => ({ headSha: "head-88", state: "pending", failures: [] }),
      } as unknown as GitHubClient,
      repository: {
        ensurePullRequestWorktree: async () => ({ branch: pullRequest.headRefName, path: worktree }),
      } as unknown as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(polls, 2);
    assert.equal(state.requireJob(88).status, "pr_open");
    assert.deepEqual(state.listEvidenceAwaitingReport(88, 88), []);
    assert.equal((await stat(invalid)).isDirectory(), true, "preserve unknown evidence, do not delete it");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
