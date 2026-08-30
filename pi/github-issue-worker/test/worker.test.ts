import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
    labelPullRequestFromIssue: async () => calls.push("label-pr"),
    markPullRequestOpen: async () => calls.push("pr-open"),
    commentIssue: async () => calls.push("comment-issue"),
    markBlocked: async () => calls.push("blocked"),
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
  };
  const repository = {
    branchForIssue: () => "pi/issue-42-add-reusable-behavior",
    pathForIssue: () => join(root, "worktree"),
    ensureIssueWorktree: async () => ({
      branch: "pi/issue-42-add-reusable-behavior",
      path: join(root, "worktree"),
    }),
    changedFiles: async () => (changed ? ["server/change.py"] : []),
    hasCommitsAhead: async () => false,
    commitAndPush: async () => ({ commit: "abc", files: ["server/change.py"] }),
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
    assert.deepEqual(calls, ["claim", "label-pr", "pr-open", "comment-issue"]);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("PR label synchronization retries without blocking an already-open pull request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-pr-label-retry-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setStatus(42, "implementing");
  let labelAttempts = 0;
  let blocked = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    findOpenPullRequest: async () => ({ number: 77, url: "https://github.com/example/widgets/pull/77" }),
    labelPullRequestFromIssue: async () => {
      labelAttempts += 1;
      if (labelAttempts === 1) throw new Error("temporary API failure");
    },
    markPullRequestOpen: async () => undefined,
    markBlocked: async () => { blocked += 1; },
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: {} as RepositoryManager,
      agent: {} as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(state.requireJob(42).status, "implementing");
    assert.equal(blocked, 0);
    await worker.tick();
    assert.equal(labelAttempts, 2);
    assert.equal(state.requireJob(42).status, "pr_open");
    assert.equal(state.requireJob(42).prNumber, 77);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted issue /pi retry restarts a blocked job without manual label changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-blocked-retry-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42-add-reusable-behavior", join(root, "worktree"), false);
  state.setStatus(42, "blocked", "old blocker");
  let claims = 0;
  const command: PullRequestFeedback = {
    eventKey: "conversation:retry-42",
    source: "conversation",
    id: 2,
    body: "/pi retry",
    author: "maintainer",
    authorAssociation: "MEMBER",
    createdAt: "2999-01-01T00:00:00Z",
    url: null,
  };
  const github = {
    listIssueCommands: async () => [command],
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    claimIssue: async () => { claims += 1; },
    findOpenPullRequest: async () => null,
    findOpenPullRequestsForIssue: async () => [],
    markBlocked: async () => undefined,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
  };
  const repository = {
    branchForIssue: () => "pi/issue-42-add-reusable-behavior",
    pathForIssue: () => join(root, "worktree"),
    ensureIssueWorktree: async () => ({
      branch: "pi/issue-42-add-reusable-behavior",
      path: join(root, "worktree"),
    }),
    changedFiles: async () => ["src/partial.ts"],
    hasCommitsAhead: async () => false,
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async () => ({ sessionFile: join(root, "session.jsonl"), finalText: "BLOCKED\nStill blocked." }),
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(claims, 1);
    assert.equal(state.requireJob(42).status, "blocked");
    assert.equal(state.hasProcessed(command.eventKey), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("initial BLOCKED output cannot be committed or pushed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-blocked-initial-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  let commits = 0;
  const visualIssue = { ...issue, labels: [{ name: "pi-visual" }] };
  const github = {
    listReadyIssues: async () => [visualIssue],
    claimIssue: async () => undefined,
    findOpenPullRequest: async () => null,
    markBlocked: async () => undefined,
    getIssue: async () => visualIssue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
  };
  const repository = {
    branchForIssue: () => "pi/issue-42-add-reusable-behavior",
    pathForIssue: () => join(root, "worktree"),
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42-add-reusable-behavior", path: join(root, "worktree") }),
    changedFiles: async () => ["src/partial.ts"],
    hasCommitsAhead: async () => false,
    clearAgentChanges: async () => undefined,
    commitAndPush: async () => {
      commits += 1;
      return { commit: "bad", files: ["src/partial.ts"] };
    },
    pushIfAhead: async () => {
      commits += 1;
    },
  };
  const agent = {
    run: async () => ({ sessionFile: join(root, "session.jsonl"), finalText: "BLOCKED\nMissing acceptance criteria." }),
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(commits, 0);
    assert.equal(state.requireJob(42).status, "blocked");
    const runs = await readdir(join(root, "worktree", ".qa", "issues", "42", "pr-pending", "runs"));
    assert.equal(runs.length, 1);
    assert.equal(state.requireEvidenceRun(42, null, runs[0]!).status, "blocked");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

test("a conflicting tracked PR is merged from base and resolved through its persistent agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-conflict-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setSession(42, join(root, "session.jsonl"));
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let runs = 0;
  let finished = 0;
  const comments: string[] = [];
  const github = {
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "feature-head",
      baseSha: "base-head",
      baseBranch: "main",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async (_pr: number, body: string) => comments.push(body),
    markBlocked: async () => undefined,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    beginBaseMerge: async () => ({
      baseSha: "base-head",
      conflicts: ["src/form.ts"],
      alreadyCurrent: false,
    }),
    finishBaseMerge: async () => {
      finished += 1;
    },
    abortBaseMerge: async () => undefined,
  };
  const agent = {
    run: async (options: { prompt: string; sessionFile: string | null }) => {
      runs += 1;
      assert.match(options.prompt, /Resolve merge conflicts/);
      assert.equal(options.sessionFile, join(root, "session.jsonl"));
      return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved both intents and tested." };
    },
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
    assert.equal(finished, 1);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), true);
    assert.match(comments[0] || "", /resolved and pushed without rebasing/);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a committed conflict resolution retries after an ambiguous push failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-push-recovery-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let localHead = "feature-head";
  let unpushed = true;
  let runs = 0;
  const github = {
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "feature-head",
      baseSha: "base-head",
      baseBranch: "main",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => localHead,
    beginBaseMerge: async () => ({
      baseSha: "base-head",
      conflicts: ["src/form.ts"],
      alreadyCurrent: false,
      mergeInProgress: true,
    }),
    finishBaseMerge: async () => {
      localHead = "merge-head";
      throw new Error("push connection reset");
    },
    recoverBaseMergePush: async () => {
      unpushed = false;
    },
    abortBaseMerge: async () => undefined,
  };
  const agent = {
    run: async () => {
      runs += 1;
      return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved and tested." };
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await assert.rejects(worker.tick(), /push connection reset/);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), false);
    await worker.tick();
    assert.equal(runs, 1);
    assert.equal(unpushed, false);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), true);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
