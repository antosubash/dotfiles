import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import type { PullRequestFeedback } from "../src/types.js";
import { IssueWorker } from "../src/worker.js";
import { config, issue } from "./helpers/worker-fixtures.js";

test("addressing_review jobs recover after a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-review-recovery-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setSession(42, join(root, "session.jsonl"));
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.setStatus(42, "addressing_review");
  const feedback: PullRequestFeedback = {
    eventKey: "review:recovery",
    source: "review",
    id: 8,
    body: "Handle the null case.",
    author: "maintainer",
    authorAssociation: "MEMBER",
    createdAt: "2026-01-02T00:00:00Z",
    url: null,
  };
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [feedback],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    hasUnpushedCommits: async () => false,
    changedFiles: async () => [],
  };
  const agent = {
    run: async () => {
      runs += 1;
      return { sessionFile: join(root, "session.jsonl"), finalText: "Recovered review work." };
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(runs, 1);
    assert.equal(state.requireJob(42).status, "pr_open");
    assert.equal(state.hasProcessed(feedback.eventKey), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("feedback BLOCKED output cannot be committed or pushed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-blocked-feedback-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let commits = 0;
  const feedback: PullRequestFeedback = {
    eventKey: "review:blocked",
    source: "review",
    id: 9,
    body: "Do the unsafe thing.",
    author: "maintainer",
    authorAssociation: "MEMBER",
    createdAt: "2026-01-02T00:00:00Z",
    url: null,
  };
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [feedback],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    changedFiles: async () => ["src/partial.ts"],
    clearAgentChanges: async () => undefined,
    commitAndPush: async () => {
      commits += 1;
      return { commit: "bad", files: ["src/partial.ts"] };
    },
  };
  const agent = {
    run: async () => ({ sessionFile: join(root, "session.jsonl"), finalText: "**BLOCKED:** Browser unavailable." }),
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(commits, 0);
    assert.equal(state.hasProcessed(feedback.eventKey), true);
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
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => {
      comments += 1;
    },
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    changedFiles: async () => (changed ? ["server/change.py"] : []),
    commitAndPush: async () => ({ commit: "def", files: ["server/change.py"] }),
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

