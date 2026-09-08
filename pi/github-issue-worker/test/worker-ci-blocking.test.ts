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
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

test("a failed blocker notification resumes without rerunning the CI agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-block-report-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let runs = 0;
  let reports = 0;
  let comments = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha: "failed-sha",
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: "failed" }],
    }),
    markBlocked: async () => { reports += 1; },
    commentPullRequest: async () => {
      comments += 1;
      if (comments === 1) throw new Error("GitHub unavailable");
    },
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async () => {
      runs += 1;
      return { sessionFile: join(root, "session.jsonl"), finalText: "**BLOCKED:** external failure" };
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await assert.rejects(worker.tick(), /GitHub unavailable/);
    assert.equal(state.requireJob(42).status, "reporting_ci_pr_comment");
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), false);
    await worker.tick();
    assert.equal(runs, 1);
    assert.equal(reports, 1);
    assert.equal(state.requireJob(42).status, "pr_open");
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a new failed head does not reuse an older committing_ci recovery phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-committing-new-head-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.recordCiAttempt(42, "old-head");
  state.setStatus(42, "committing_ci", "crashed after old push");
  let runs = 0;
  let commits = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha: "new-failed-head",
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: "failed" }],
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    changedFiles: async () => ["src/next-fix.py"],
    commitAndPush: async () => { commits += 1; return { commit: "next", files: ["src/next-fix.py"] }; },
  };
  const agent = {
    run: async () => {
      runs += 1;
      return { sessionFile: join(root, "session.jsonl"), finalText: "Fixed the new failure." };
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
    assert.equal(commits, 1);
    assert.equal(state.hasProcessed("ci-failure:77:new-failed-head"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted /pi retry reopens the same processed CI head with a fresh bounded cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-explicit-retry-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.recordCiAttempt(42, "failed-sha");
  state.setStatus(42, "pr_open", "external blocker resolved");
  state.markProcessed(42, "ci-failure:77:failed-sha");
  state.markProcessed(42, "ci-rerun:77:failed-sha");
  const retry: PullRequestFeedback = {
    eventKey: "conversation:retry-ci",
    source: "conversation",
    id: 11,
    body: "/pi retry",
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
    listFeedback: async () => [retry],
    getPullRequestChecks: async () => ({
      headSha: "failed-sha",
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: "failed" }],
    }),
    markPullRequestOpen: async () => undefined,
    markBlocked: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async () => {
      runs += 1;
      return { sessionFile: join(root, "session.jsonl"), finalText: "**BLOCKED:** fixture" };
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
    assert.equal(state.requireJob(42).ciAttempts, 1);
    assert.equal(state.hasProcessed(retry.eventKey), true);
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), true);
    assert.equal(state.hasProcessed("ci-rerun:77:failed-sha"), false);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reporting_ci_block state does not apply an old blocker to a newer failed head", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-report-new-head-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.recordCiAttempt(42, "old-head");
  state.setStatus(42, "reporting_ci_block", "old blocker");
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha: "new-head",
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: "failed" }],
    }),
    markBlocked: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async () => {
      runs += 1;
      return { sessionFile: join(root, "session.jsonl"), finalText: "**BLOCKED:** new diagnosis" };
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
    assert.match(state.requireJob(42).lastError || "", /new diagnosis/);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
