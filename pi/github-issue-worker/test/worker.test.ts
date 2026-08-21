import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import type { GitHubIssue, PullRequestFeedback } from "../src/types.js";
import { IssueWorker } from "../src/worker.js";

const issue: GitHubIssue = {
  number: 42,
  title: "Add reusable behavior",
  body: "Acceptance criteria",
  url: "https://github.com/example/widgets/issues/42",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "pi-ready" }],
  author: { login: "maintainer" },
};

function config(root: string) {
  return loadConfig({
    HOME: root,
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
    PI_WORKER_DATA_DIR: join(root, "data"),
  });
}

test("worker claims an approved issue and opens a draft PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-flow-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  let changed = false;
  const calls: string[] = [];
  const github = {
    listReadyIssues: async () => [issue],
    claimIssue: async () => calls.push("claim"),
    findOpenPullRequest: async () => null,
    createDraftPullRequest: async () => ({ number: 77, url: "https://github.com/example/widgets/pull/77" }),
    markPullRequestOpen: async () => calls.push("pr-open"),
    commentIssue: async () => calls.push("comment-issue"),
    markBlocked: async () => calls.push("blocked"),
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
  };
  const repository = {
    branchForIssue: () => "pi/issue-42-add-reusable-behavior",
    pathForIssue: () => join(root, "worktree"),
    ensureIssueWorktree: async () => ({
      branch: "pi/issue-42-add-reusable-behavior",
      path: join(root, "worktree"),
    }),
    changedFiles: async () => (changed ? ["src/change.ts"] : []),
    hasCommitsAhead: async () => false,
    commitAndPush: async () => ({ commit: "abc", files: ["src/change.ts"] }),
    pushIfAhead: async () => undefined,
  };
  const agent = {
    run: async () => {
      changed = true;
      return { sessionFile: join(root, "session.jsonl"), finalText: "Implemented and tested." };
    },
  };

  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    const job = state.requireJob(42);
    assert.equal(job.status, "pr_open");
    assert.equal(job.prNumber, 77);
    assert.deepEqual(calls, ["claim", "pr-open", "comment-issue"]);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted review feedback reuses the job and records event idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-review-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const cfg = config(root);
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setSession(42, join(root, "session.jsonl"));
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  const review: PullRequestFeedback = {
    eventKey: "review_comment:9",
    source: "review_comment",
    id: 9,
    body: "Handle the null case.",
    author: "maintainer",
    authorAssociation: "MEMBER",
    createdAt: "2026-01-02T00:00:00Z",
    url: null,
  };
  let changed = false;
  let comments = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [review],
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => {
      comments += 1;
    },
    markBlocked: async () => undefined,
  };
  const repository = {
    changedFiles: async () => (changed ? ["src/change.ts"] : []),
    commitAndPush: async () => ({ commit: "def", files: ["src/change.ts"] }),
  };
  const agent = {
    run: async () => {
      changed = true;
      return { sessionFile: join(root, "session.jsonl"), finalText: "Null case covered." };
    },
  };

  try {
    const worker = new IssueWorker(cfg, state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(state.requireJob(42).status, "pr_open");
    assert.equal(state.hasProcessed(review.eventKey), true);
    assert.equal(comments, 1);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
