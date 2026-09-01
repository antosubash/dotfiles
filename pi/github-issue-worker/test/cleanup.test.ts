import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PullRequestWorktreeCleanupService } from "../src/cleanup.js";
import type { GitHubClient } from "../src/github.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import type { GitHubPullRequest } from "../src/types.js";

const pullRequest: GitHubPullRequest = {
  number: 88,
  title: "Adopt me",
  body: "/pi fix conflicts",
  url: "https://github.com/example/widgets/pull/88",
  updatedAt: "2026-09-01T00:00:00Z",
  labels: [{ name: "pi-ready" }],
  author: { login: "maintainer" },
  headRefName: "feature/adopt-me",
  headRefOid: "abc123",
  baseRefName: "main",
  isCrossRepository: false,
};

test("merged pull request cleanup removes its managed worktree exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-cleanup-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.adoptPullRequest(pullRequest, join(root, "worktrees", "pr-88"), false);
  state.recordEvidenceRun(88, 88, "20260901T010101Z");
  const removals: unknown[][] = [];
  const github = {
    getPullRequestLifecycle: async () => ({
      state: "MERGED" as const,
      mergedAt: "2026-09-01T01:00:00Z",
      headSha: "abc123",
    }),
  };
  const repository = {
    removeManagedWorktree: async (...args: unknown[]) => {
      removals.push(args);
    },
  };
  try {
    const service = new PullRequestWorktreeCleanupService(
      state,
      github as unknown as GitHubClient,
      repository as unknown as RepositoryManager,
    );
    await service.run();
    assert.equal(removals.length, 0);
    state.setEvidenceRunStatus(
      88,
      88,
      "20260901T010101Z",
      "published",
      "\n\n![QA](https://example.invalid/qa.png)",
    );
    await service.run();
    assert.equal(removals.length, 0);
    state.markProcessed(88, "evidence:88:20260901T010101Z");
    await service.run();
    await service.run();
    assert.equal(removals.length, 1);
    assert.deepEqual(removals[0], [
      "pull_request",
      88,
      join(root, "worktrees", "pr-88"),
      "feature/adopt-me",
      "abc123",
    ]);
    assert.equal(state.requireJob(88).status, "completed");
    assert.equal(state.hasProcessed("worktree-cleanup:88:abc123"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closed but unmerged pull requests retain their worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-cleanup-closed-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.adoptPullRequest(pullRequest, join(root, "worktrees", "pr-88"), false);
  let removals = 0;
  try {
    const service = new PullRequestWorktreeCleanupService(
      state,
      {
        getPullRequestLifecycle: async () => ({
          state: "CLOSED" as const,
          mergedAt: null,
          headSha: "abc123",
        }),
      } as unknown as GitHubClient,
      {
        removeManagedWorktree: async () => {
          removals += 1;
        },
      } as unknown as RepositoryManager,
    );
    await service.run();
    assert.equal(removals, 0);
    assert.equal(state.requireJob(88).status, "pr_open");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
