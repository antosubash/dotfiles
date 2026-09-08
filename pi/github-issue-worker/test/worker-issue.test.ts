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

test("tracked open PRs created before the upgrade receive a one-time label backfill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-pr-label-backfill-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  let labels = 0;
  const github = {
    listReadyIssues: async () => [],
    getIssue: async () => issue,
    isPullRequestOpen: async () => true,
    labelPullRequestFromIssue: async () => { labels += 1; },
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
    await worker.tick();
    assert.equal(labels, 1);
    assert.equal(state.hasProcessed("pr-labels:77"), true);
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
  let evidenceRunId = "";
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
    ensureIssueWorktree: async () => {
      await mkdir(join(root, "worktree"));
      return { branch: "pi/issue-42-add-reusable-behavior", path: join(root, "worktree") };
    },
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
    run: async (options: { prompt: string }) => {
      evidenceRunId = options.prompt.match(/runs\/(\d{8}T\d{6}Z)/)?.[1] ?? "";
      return { sessionFile: join(root, "session.jsonl"), finalText: "BLOCKED\nMissing acceptance criteria." };
    },
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
    assert.match(evidenceRunId, /^\d{8}T\d{6}Z$/);
    assert.equal(state.requireEvidenceRun(42, null, evidenceRunId).status, "blocked");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
