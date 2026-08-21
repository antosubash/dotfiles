import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileLock } from "../src/lock.js";
import { WorkerState } from "../src/state.js";
import type { GitHubIssue } from "../src/types.js";

const issue: GitHubIssue = {
  number: 42,
  title: "Do the thing",
  body: "Acceptance criteria",
  url: "https://github.com/example/repo/issues/42",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "pi-ready" }],
  author: { login: "maintainer" },
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
    state.markProcessed(42, "review:7");
    state.close();

    const reopened = new WorkerState(path);
    const job = reopened.requireJob(42);
    assert.equal(job.prNumber, 99);
    assert.equal(job.status, "pr_open");
    assert.equal(job.sessionFile, "/tmp/session.jsonl");
    assert.equal(reopened.hasProcessed("review:7"), true);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
