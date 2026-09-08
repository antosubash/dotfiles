import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import type { GitHubPullRequest } from "../src/types.js";
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

test("worker adopts a pi-ready pull request into an isolated tracked worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-adopt-pr-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const pullRequest: GitHubPullRequest = {
    ...issue,
    number: 88,
    title: "Adopt existing work",
    body: "/pi fix the conflicts",
    url: "https://github.com/example/widgets/pull/88",
    labels: [{ name: "pi-ready" }],
    headRefName: "feature/adopt-me",
    headRefOid: "head-88",
    baseRefName: "main",
    isCrossRepository: false,
  };
  const calls: string[] = [];
  const github = {
    listReadyIssues: async () => [],
    listReadyPullRequests: async () => [pullRequest],
    claimPullRequest: async () => calls.push("claim-pr"),
    activatePullRequest: async () => calls.push("activate-pr"),
    getIssue: async () => pullRequest,
    getPullRequest: async () => pullRequest,
    labelPullRequestFromIssue: async () => calls.push("label-pr"),
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "head-88",
      baseSha: "base",
      baseBranch: "main",
      mergeable: "MERGEABLE" as const,
      mergeStateStatus: "CLEAN",
    }),
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "head-88", state: "pending", failures: [] }),
  };
  const repository = {
    pathForPullRequest: () => join(root, "worktrees", "pr-88"),
    ensurePullRequestWorktree: async () => ({
      branch: "feature/adopt-me",
      path: join(root, "worktrees", "pr-88"),
    }),
    headRevision: async () => "head-88",
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    const job = state.requireJob(88);
    assert.equal(job.kind, "pull_request");
    assert.equal(job.prNumber, 88);
    assert.equal(job.status, "pr_open");
    assert.equal(job.worktreePath, join(root, "worktrees", "pr-88"));
    assert.deepEqual(calls, ["claim-pr", "activate-pr"]);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adopted PR label activation recovers after a claim-time crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-adopt-pr-label-recovery-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const pullRequest: GitHubPullRequest = {
    ...issue,
    number: 88,
    url: "https://github.com/example/widgets/pull/88",
    headRefName: "feature/adopt-me",
    headRefOid: "head-88",
    baseRefName: "main",
    isCrossRepository: false,
  };
  state.adoptPullRequest(pullRequest, join(root, "worktrees", "pr-88"), false);
  let activations = 0;
  try {
    const worker = new IssueWorker(config(root), state, {
      github: {
        listReadyIssues: async () => [],
        listReadyPullRequests: async () => [],
        isPullRequestOpen: async () => true,
        getPullRequest: async () => pullRequest,
        activatePullRequest: async () => {
          activations += 1;
        },
        getPullRequestMergeState: async () => ({
          headSha: "head-88",
          baseSha: "base",
          baseBranch: "main",
          mergeable: "MERGEABLE" as const,
          mergeStateStatus: "CLEAN",
        }),
        listFeedback: async () => [],
        getPullRequestChecks: async () => ({ headSha: "head-88", state: "pending", failures: [] }),
      } as unknown as GitHubClient,
      repository: {
        ensurePullRequestWorktree: async () => ({
          branch: "feature/adopt-me",
          path: join(root, "worktrees", "pr-88"),
        }),
      } as unknown as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(activations, 1);
    assert.equal(state.hasProcessed("pr-labels:88"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("completed PR jobs recover evidence markers without duplicate comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-completed-evidence-recovery-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const pullRequest: GitHubPullRequest = {
    ...issue,
    number: 88,
    url: "https://github.com/example/widgets/pull/88",
    headRefName: "feature/adopt-me",
    headRefOid: "head-88",
    baseRefName: "main",
    isCrossRepository: false,
  };
  state.adoptPullRequest(pullRequest, join(root, "worktrees", "pr-88"), false);
  state.setStatus(88, "completed");
  state.recordEvidenceRun(
    88,
    88,
    "20260901T010101Z",
    "published",
    "\n\n![QA](https://example.invalid/qa.png)",
  );
  const comments: string[] = [];
  try {
    const worker = new IssueWorker(config(root), state, {
      github: {
        listReadyIssues: async () => [],
        listReadyPullRequests: async () => [],
        hasPullRequestCommentMarker: async (_number: number, marker: string) =>
          marker === "<!-- pi-worker-evidence:88:20260901T010101Z -->",
        commentPullRequest: async (_number: number, body: string) => {
          comments.push(body);
        },
      } as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(comments.length, 0);
    assert.equal(state.hasProcessed("evidence:88:20260901T010101Z"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker rejects fork pull requests before claiming or persisting adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-reject-fork-pr-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const pullRequest: GitHubPullRequest = {
    ...issue,
    number: 88,
    url: "https://github.com/example/widgets/pull/88",
    headRefName: "feature/from-fork",
    headRefOid: "head-88",
    baseRefName: "main",
    isCrossRepository: true,
  };
  let claims = 0;
  let blocked = 0;
  try {
    const worker = new IssueWorker(config(root), state, {
      github: {
        listReadyIssues: async () => [],
        listReadyPullRequests: async () => [pullRequest],
        claimPullRequest: async () => {
          claims += 1;
        },
        markBlocked: async () => {
          blocked += 1;
        },
      } as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(claims, 0);
    assert.equal(blocked, 1);
    assert.equal(state.getJob(88), null);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid tracked ready PRs are blocked without aborting the poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-invalid-tracked-pr-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const original: GitHubPullRequest = {
    ...issue,
    number: 88,
    url: "https://github.com/example/widgets/pull/88",
    headRefName: "feature/adopt-me",
    headRefOid: "head-88",
    baseRefName: "main",
    isCrossRepository: false,
  };
  state.adoptPullRequest(original, join(root, "worktrees", "pr-88"), false);
  let blocked = 0;
  try {
    const worker = new IssueWorker(config(root), state, {
      github: {
        listReadyIssues: async () => [],
        listReadyPullRequests: async () => [{ ...original, baseRefName: "release" }],
        markBlocked: async () => {
          blocked += 1;
        },
      } as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(blocked, 1);
    assert.equal(state.requireJob(88).status, "blocked");
    assert.match(state.requireJob(88).lastError || "", /configured base is main/);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
