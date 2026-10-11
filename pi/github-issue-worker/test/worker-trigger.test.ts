import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { TrustService } from "../src/github/trust.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import type { GitHubIssue } from "../src/types.js";
import { config, issue, TestIssueWorker as IssueWorker, trustingTrust } from "./helpers/worker-fixtures.js";

async function harness(options: { trust: Partial<TrustService>; ready?: GitHubIssue[]; planning?: GitHubIssue[] }) {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-trigger-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const calls: string[] = [];
  const rejections: Array<[number, string, string]> = [];
  const github = {
    listReadyIssues: async () => options.ready ?? [],
    listPlanningIssues: async () => options.planning ?? [],
    rejectTrigger: async (number: number, label: string, message: string) => { rejections.push([number, label, message]); },
    claimIssue: async () => { calls.push("claim"); },
    finishPlanning: async () => { calls.push("finish-planning"); },
    getIssue: async () => issue,
    findOpenPullRequest: async () => null,
    findOpenPullRequestsForIssue: async () => [],
    markBlocked: async () => { calls.push("blocked"); },
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "abc", state: "pending", failures: [] }),
  };
  const repository = {
    branchForIssue: () => "pi/issue-42",
    pathForIssue: () => join(root, "worktree"),
    ensureIssueWorktree: async () => { calls.push("worktree"); return { branch: "pi/issue-42", path: join(root, "worktree") }; },
  };
  const agent = { run: async () => { calls.push("agent"); throw new Error("the agent must not run"); } };
  const worker = new IssueWorker(config(root), state, {
    github: github as unknown as GitHubClient,
    trust: { ...trustingTrust, ...options.trust },
    repository: repository as unknown as RepositoryManager,
    agent: agent as unknown as PiAgentRunner,
    plans: { load: async () => null, create: async () => { calls.push("plan"); throw new Error("planning must not run"); } },
  });
  return {
    worker, state, calls, rejections, root,
    cleanup: async () => { state.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("an issue from an author without write access is rejected once and never claimed", async () => {
  const h = await harness({ ready: [issue], trust: { canWrite: async (login) => login !== issue.author.login } });
  try {
    await h.worker.tick();
    assert.equal(h.rejections.length, 1);
    const [number, label, message] = h.rejections[0]!;
    assert.equal(number, 42);
    assert.equal(label, "pi-ready");
    assert.match(message, /author `maintainer`/);
    assert.ok(!h.calls.includes("claim"));
    assert.equal(h.state.getJob(42), null);
  } finally {
    await h.cleanup();
  }
});

test("a transient trust error neither rejects nor claims, so the next poll retries", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  const h = await harness({ ready: [issue], trust: { approval: async () => { throw new Error("HTTP 502"); } } });
  try {
    await h.worker.tick();
    assert.deepEqual(h.rejections, []);
    assert.ok(!h.calls.includes("claim"));
    assert.equal(h.state.getJob(42), null);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /trigger check for #42 deferred: HTTP 502/);
  } finally {
    await h.cleanup();
  }
});

test("resuming a job whose issue changed since approval blocks it without running the agent", async () => {
  const h = await harness({ trust: {} });
  try {
    h.state.claim(issue, "pi/issue-42", join(h.root, "worktree"), false, "stale");
    h.state.setStatus(42, "implementing");
    await h.worker.tick();
    const job = h.state.requireJob(42);
    assert.equal(job.status, "blocked");
    assert.match(job.lastError ?? "", /changed since it was approved/);
    assert.ok(!h.calls.includes("agent"));
    assert.ok(!h.calls.includes("worktree"));
  } finally {
    await h.cleanup();
  }
});

test("a planning request labelled by a user without write access is rejected under pi-plan", async () => {
  const planning = { ...issue, labels: [{ name: "pi-plan" }] };
  const h = await harness({
    planning: [planning],
    trust: {
      canWrite: async (login) => login !== "outsider",
      approval: async () => ({ labeledBy: "outsider", labeledAt: "2026-01-02T00:00:00Z", renames: [] }),
    },
  });
  try {
    await h.worker.tick();
    assert.equal(h.rejections.length, 1);
    assert.equal(h.rejections[0]![1], "pi-plan");
    assert.match(h.rejections[0]![2], /added by `outsider`/);
    assert.ok(!h.calls.includes("plan"));
    assert.ok(!h.calls.includes("finish-planning"));
  } finally {
    await h.cleanup();
  }
});
