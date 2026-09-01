import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ProfileLock } from "../src/lock.js";
import { WorkerState } from "../src/state.js";
import type { GitHubIssue, GitHubPullRequest } from "../src/types.js";

const issue: GitHubIssue = {
  number: 42,
  title: "Do the thing",
  body: "Acceptance criteria",
  url: "https://github.com/example/repo/issues/42",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "pi-ready" }],
  author: { login: "maintainer" },
};

const pullRequest: GitHubPullRequest = {
  ...issue,
  number: 88,
  title: "Adopt this pull request",
  url: "https://github.com/example/repo/pull/88",
  headRefName: "feature/adopt-me",
  headRefOid: "abc123",
  baseRefName: "main",
  isCrossRepository: false,
};

test("a profile lock rejects a concurrent worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-lock-"));
  try {
    const first = await ProfileLock.acquire(directory);
    await assert.rejects(ProfileLock.acquire(directory), /already running/);
    await first.release();
    const second = await ProfileLock.acquire(directory);
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state migrates pre-CI databases in place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-state-migration-"));
  const path = join(directory, "state.sqlite");
  try {
    new WorkerState(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE issue_jobs DROP COLUMN job_kind");
    legacy.exec("ALTER TABLE issue_jobs DROP COLUMN ci_attempts");
    legacy.exec("ALTER TABLE issue_jobs DROP COLUMN ci_head_sha");
    legacy.close();

    const migrated = new WorkerState(path);
    const inspection = new DatabaseSync(path);
    const columns = (inspection.prepare("PRAGMA table_info(issue_jobs)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    inspection.close();
    assert.ok(columns.includes("job_kind"));
    assert.ok(columns.includes("ci_attempts"));
    assert.ok(columns.includes("ci_head_sha"));
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state migration reports duplicate legacy pull request jobs before indexing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-duplicate-pr-state-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE issue_jobs (
        issue_number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        session_file TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        visual_requested INTEGER NOT NULL DEFAULT 0,
        ci_attempts INTEGER NOT NULL DEFAULT 0,
        ci_head_sha TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO issue_jobs VALUES
        (1, 'one', 'pr_open', 'one', '/tmp/one', NULL, 99, 'url', 0, 0, NULL, NULL, 'now', 'now'),
        (2, 'two', 'pr_open', 'two', '/tmp/two', NULL, 99, 'url', 0, 0, NULL, NULL, 'now', 'now');
    `);
    legacy.close();
    assert.throws(() => new WorkerState(path), /duplicate pull request jobs: #99 \(2\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state adopts labeled pull requests without colliding with issue jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-pr-state-"));
  const path = join(directory, "state.sqlite");
  try {
    const state = new WorkerState(path);
    const adopted = state.adoptPullRequest(pullRequest, "/tmp/pr-88", true);
    assert.equal(adopted.kind, "pull_request");
    assert.equal(adopted.status, "pr_open");
    assert.equal(adopted.prNumber, 88);
    assert.equal(adopted.branch, "feature/adopt-me");
    assert.equal(state.getJobByPullRequest(88)?.issueNumber, 88);
    assert.deepEqual(state.listTrackedPullRequests().map((job) => job.prNumber), [88]);
    state.claim(issue, "pi/issue-42", "/tmp/issue-42", false);
    assert.equal(state.requireJob(42).kind, "issue");
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence state associates pending runs and terminal failures never republish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-evidence-state-"));
  const path = join(directory, "state.sqlite");
  try {
    const state = new WorkerState(path);
    state.claim(issue, "pi/issue-42", "/tmp/worktree", true);
    state.recordEvidenceRun(42, null, "20260101T010101Z");
    state.setEvidenceRunStatus(42, null, "20260101T010101Z", "valid");
    state.recordEvidenceRun(42, null, "20260101T020202Z", "blocked", "backend unavailable");
    state.associatePendingEvidence(42, 99);
    assert.deepEqual(
      state.listPublishableEvidence(42, 99).map((run) => [run.runId, run.status]),
      [["20260101T010101Z", "valid"]],
    );
    state.setEvidenceRunStatus(42, 99, "20260101T010101Z", "published");
    state.recordEvidenceRun(42, 99, "20260101T010101Z", "pending");
    assert.equal(state.requireEvidenceRun(42, 99, "20260101T010101Z").status, "published");
    assert.equal(state.requireEvidenceRun(42, 99, "20260101T020202Z").status, "blocked");
    assert.deepEqual(state.listPublishableEvidence(42, 99), []);
    state.close();

    const reopened = new WorkerState(path);
    assert.equal(reopened.requireEvidenceRun(42, 99, "20260101T010101Z").status, "published");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state persists jobs, pull requests, and event idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-state-"));
  const path = join(directory, "state.sqlite");
  try {
    const state = new WorkerState(path);
    const claimed = state.claim(issue, "pi/issue-42", "/tmp/worktree", false);
    assert.equal(claimed.status, "claimed");
    const retitled = state.claim({ ...issue, title: "A new title" }, "pi/issue-42-a-new-title", "/tmp/new-worktree", false);
    assert.equal(retitled.branch, "pi/issue-42");
    assert.equal(retitled.worktreePath, "/tmp/worktree");
    state.setSession(42, "/tmp/session.jsonl");
    state.setPullRequest(42, 99, "https://github.com/example/repo/pull/99");
    assert.equal(state.recordCiAttempt(42, "head-one"), 1);
    assert.equal(state.recordCiAttempt(42, "head-one"), 1);
    assert.equal(state.recordCiAttempt(42, "head-two"), 2);
    state.markProcessed(42, "review:7");
    state.completeEvent(42, "ci-pass:99:head-two", "pr_open");
    state.close();

    const reopened = new WorkerState(path);
    const job = reopened.requireJob(42);
    assert.equal(job.kind, "issue");
    assert.equal(job.prNumber, 99);
    assert.equal(job.status, "pr_open");
    assert.equal(job.sessionFile, "/tmp/session.jsonl");
    assert.equal(job.ciAttempts, 2);
    assert.equal(job.ciHeadSha, "head-two");
    assert.equal(reopened.hasProcessed("review:7"), true);
    assert.equal(reopened.hasProcessed("ci-pass:99:head-two"), true);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
