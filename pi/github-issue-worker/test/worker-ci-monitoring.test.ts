import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import { IssueWorker } from "../src/worker.js";
import { config, issue } from "./helpers/worker-fixtures.js";

test("pending CI checks are observed without invoking the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-pending-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "pending-sha", state: "pending", failures: [] }),
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: { run: async () => { runs += 1; throw new Error("unexpected"); } } as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(runs, 0);
    assert.equal(state.requireJob(42).status, "pr_open");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runner infrastructure failures rerun without invoking Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-infra-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let reruns = 0;
  let rerunPending = false;
  let agentRuns = 0;
  const failures = [{
    name: "build",
    conclusion: "STARTUP_FAILURE",
    detailsUrl: "https://github.com/example/widgets/actions/runs/123/job/456",
    excerpt: "The job was not acquired by Runner",
  }];
  const github = {
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () =>
      rerunPending
        ? ({ headSha: "infra-head", state: "pending", failures: [] } as const)
        : ({ headSha: "infra-head", state: "failed", failures } as const),
    rerunFailedWorkflowRuns: async () => { reruns += 1; rerunPending = true; return 1; },
    commentPullRequest: async () => undefined,
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: { run: async () => { agentRuns += 1; throw new Error("unexpected"); } } as unknown as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(reruns, 1);
    assert.equal(agentRuns, 0);
    assert.equal(state.hasProcessed("ci-rerun:77:infra-head"), true);
    assert.equal(state.hasProcessed("ci-failure:77:infra-head"), false);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed CI head is repaired once and repeated polling is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-failed-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setSession(42, join(root, "session.jsonl"));
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
      failures: [{ name: "Python tests", conclusion: "FAILURE", detailsUrl: null, excerpt: "AssertionError" }],
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    changedFiles: async () => ["src/fix.py"],
    commitAndPush: async () => { commits += 1; return { commit: "fixed", files: ["src/fix.py"] }; },
  };
  const agent = {
    run: async () => { runs += 1; return { sessionFile: join(root, "session.jsonl"), finalText: "Fixed and tested." }; },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(runs, 1);
    assert.equal(commits, 1);
    assert.equal(state.requireJob(42).ciAttempts, 1);
    assert.equal(state.hasProcessed("ci-failure:77:failed-sha"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a new failed CI head starts the next bounded repair attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-new-head-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let headSha = "failed-one";
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha,
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: null }],
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    changedFiles: async () => ["src/fix.py"],
    commitAndPush: async () => ({ commit: "fixed", files: ["src/fix.py"] }),
  };
  const agent = { run: async () => { runs += 1; return { sessionFile: join(root, "session.jsonl"), finalText: "Fixed." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    headSha = "failed-two";
    await worker.tick();
    assert.equal(runs, 2);
    assert.equal(state.requireJob(42).ciAttempts, 2);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("passing CI resets repair attempts and reports each head only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-passed-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.recordCiAttempt(42, "failed-sha");
  let comments = 0;
  const github = {
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "passed-sha", state: "passed", failures: [] }),
    markPullRequestOpen: async () => undefined,
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
    assert.equal(state.requireJob(42).ciAttempts, 0);
    assert.equal(state.requireJob(42).ciHeadSha, "passed-sha");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("exhausted CI repair attempts block once without invoking the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-ci-exhausted-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.recordCiAttempt(42, "one");
  state.recordCiAttempt(42, "two");
  state.recordCiAttempt(42, "three");
  let blocked = 0;
  let comments = 0;
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({
      headSha: "four",
      state: "failed",
      failures: [{ name: "tests", conclusion: "FAILURE", detailsUrl: null, excerpt: null }],
    }),
    markBlocked: async () => { blocked += 1; },
    commentPullRequest: async () => { comments += 1; },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: { run: async () => { runs += 1; throw new Error("unexpected"); } } as unknown as PiAgentRunner,
    });
    await worker.tick();
    await worker.tick();
    assert.equal(runs, 0);
    assert.equal(blocked, 1);
    assert.equal(comments, 1);
    assert.equal(state.hasProcessed("ci-failure:77:four"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

