import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import type { PullRequestFeedback } from "../src/types.js";
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

test("an interrupted CI repair remains resumable and does not consume the head twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-recovery-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let runs = 0;
  let commits = 0;
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
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    hasUnpushedCommits: async () => false,
    changedFiles: async () => ["src/fix.py"],
    commitAndPush: async () => { commits += 1; return { commit: "fixed", files: ["src/fix.py"] }; },
  };
  const agent = {
    run: async () => {
      runs += 1;
      if (runs === 1) throw new Error("aborted");
      return { sessionFile: join(root, "session.jsonl"), finalText: "Recovered and fixed." };
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await assert.rejects(worker.tick(), /aborted/);
    assert.equal(state.requireJob(42).status, "addressing_ci");
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), false);
    await worker.tick();
    assert.equal(runs, 2);
    assert.equal(commits, 1);
    assert.equal(state.requireJob(42).ciAttempts, 1);
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted visual wording enables the browser sandbox even outside the verify alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-visual-wording-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  await mkdir(join(root, "worktree"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let visualVerification = false;
  const feedback: PullRequestFeedback = {
    eventKey: "conversation:visual",
    source: "conversation",
    id: 10,
    body: "/pi add visual confirmation",
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
    markBlocked: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async (options: { visualVerification?: boolean }) => {
      visualVerification = options.visualVerification === true;
      return { sessionFile: join(root, "session.jsonl"), finalText: "**BLOCKED:** smoke only" };
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(visualVerification, true);
    assert.equal(state.hasProcessed(feedback.eventKey), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a committing_ci restart pushes an already-committed repair without rerunning Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-ahead-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.recordCiAttempt(42, "older-one");
  state.recordCiAttempt(42, "older-two");
  state.recordCiAttempt(42, "failed-sha");
  state.setStatus(42, "committing_ci", "push interrupted");
  let pushes = 0;
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha: "failed-sha",
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: null }],
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    hasUnpushedCommits: async () => true,
    pushIfAhead: async () => { pushes += 1; },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: { run: async () => { runs += 1; throw new Error("unexpected"); } } as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(pushes, 1);
    assert.equal(runs, 0);
    assert.equal(state.requireJob(42).status, "pr_open");
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a head with no registered checks is reported once without invoking Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-none-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let comments = 0;
  const github = {
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "no-checks", state: "none", failures: [] }),
    commentPullRequest: async () => { comments += 1; },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(comments, 1);
    assert.equal(state.hasProcessed("ci-none:77:no-checks"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser CI failures enable the visual Unix-socket sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-browser-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  await mkdir(join(root, "worktree"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let visualVerification = false;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha: "browser-failed",
      state: "failed",
      failures: [{ name: "E2E smoke (Playwright)", conclusion: "FAILURE", detailsUrl: null, excerpt: "failed" }],
    }),
    markBlocked: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async (options: { visualVerification?: boolean }) => {
      visualVerification = options.visualVerification === true;
      return { sessionFile: join(root, "session.jsonl"), finalText: "**BLOCKED:** browser fixture" };
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(visualVerification, true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-interruption Pi failure blocks the CI head without an unbounded retry loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-agent-failure-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let runs = 0;
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
    markBlocked: async () => undefined,
    commentPullRequest: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    clearAgentChanges: async () => undefined,
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: { run: async () => { runs += 1; throw new Error("provider unavailable"); } } as unknown as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(runs, 1);
    assert.equal(state.requireJob(42).status, "pr_open");
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
