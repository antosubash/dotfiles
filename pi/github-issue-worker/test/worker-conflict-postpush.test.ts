import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fixture(root: string, order: string[], overrides: { github?: Record<string, unknown>; repository?: Record<string, unknown> } = {}) {
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({ headSha: "feature-head", baseSha: "base-head", baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async (_pr: number, body: string) => { order.push(`comment:${body.split("\n")[0]}`); },
    markBlocked: async () => { order.push("blocked"); },
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
    ...overrides.github,
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    beginBaseMerge: async () => ({ baseSha: "base-head", conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true }),
    stageBaseMerge: async () => { order.push("staged"); },
    finishBaseMerge: async () => { order.push("push"); },
    abortBaseMerge: async () => { order.push("abort"); },
    clearAgentChanges: async () => { order.push("discard"); },
    ...overrides.repository,
  };
  const agent = { run: async () => { order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  return { state, github: github as unknown as GitHubClient, repository: repository as unknown as RepositoryManager, agent: agent as unknown as PiAgentRunner };
}

test("a resolution is pushed before verification; a failed verification is reported, not reverted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-postpush-"));
  const order: string[] = [];
  const f = fixture(root, order);
  try {
    const worker = new IssueWorker(config(root), f.state, {
      ...f,
      qaVerifier: { verify: async () => { order.push("verify"); throw new Error("Independent QA gate: Independent QA FAILED: colours off. Local report: /v/issue-42/r/result.json"); } },
    });
    await worker.tick();
    assert.deepEqual(order.filter((entry) => !entry.startsWith("comment:")), ["resolved", "staged", "push", "verify"]);
    assert.ok(order.some((entry) => entry === "comment:🔀 Base-branch conflicts resolved and pushed. Verification follows."), order.join(" | "));
    assert.ok(order.some((entry) => entry.startsWith("comment:⚠️ Post-resolution verification failed — the resolution stays pushed; CI is the other check.")), order.join(" | "));
    assert.ok(!order.includes("blocked") && !order.includes("abort") && !order.includes("discard"));
    assert.equal(f.state.getJob(42)?.status, "pr_open");
    assert.match(f.state.getJob(42)?.lastError ?? "", /colours off/);
    assert.equal(f.state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), true);
  } finally {
    f.state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a passed post-resolution verification publishes the verifier's evidence directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-postpush-evidence-"));
  const order: string[] = [];
  const published: Array<{ prNumber: number; runId: string; names: string[] }> = [];
  const f = fixture(root, order, {
    github: {
      publishEvidence: async (prNumber: number, _head: string, runId: string, attachments: Array<{ name: string }>) => {
        published.push({ prNumber, runId, names: attachments.map((a) => a.name).sort() });
        return "\n\n### Attached QA evidence\n(two images)";
      },
    },
  });
  const report = join(root, "verification", "issue-42", "run-7", "result.json");
  await mkdir(join(root, "verification", "issue-42", "run-7", "evidence"), { recursive: true });
  await writeFile(join(root, "verification", "issue-42", "run-7", "evidence", "desktop.png"), validPng);
  await writeFile(join(root, "verification", "issue-42", "run-7", "evidence", "mobile.png"), validPng);
  try {
    const worker = new IssueWorker(config(root), f.state, { ...f, qaVerifier: { verify: async () => { order.push("verify"); return report; } } });
    await worker.tick();
    assert.deepEqual(order.filter((entry) => !entry.startsWith("comment:")), ["resolved", "staged", "push", "verify"]);
    assert.deepEqual(published, [{ prNumber: 77, runId: "run-7", names: ["desktop.png", "mobile.png"] }]);
    assert.ok(order.some((entry) => entry === "comment:✅ Post-resolution verification passed."), order.join(" | "));
    assert.equal(f.state.hasProcessed("evidence:77:run-7"), true);
    assert.equal(f.state.getJob(42)?.status, "pr_open");
    assert.equal(f.state.getJob(42)?.lastError ?? null, null);
  } finally {
    f.state.close();
    await rm(root, { recursive: true, force: true });
  }
});

// After the push nothing may reach the abort/discard path: even a GitHub outage while reporting the
// verdict leaves the pushed resolution alone and records the pending report on the job.
test("a GitHub outage while reporting a post-push verdict never aborts the pushed resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-postpush-outage-"));
  const order: string[] = [];
  let verifying = false;
  const f = fixture(root, order, {
    github: {
      commentPullRequest: async (_pr: number, body: string) => {
        if (verifying) throw new Error("gh api failed (1): 401 Unauthorized");
        order.push(`comment:${body.split("\n")[0]}`);
      },
    },
  });
  try {
    const worker = new IssueWorker(config(root), f.state, { ...f, qaVerifier: { verify: async () => { order.push("verify"); verifying = true; return "/private/qa/result.json"; } } });
    await worker.tick();
    assert.deepEqual(order.filter((entry) => !entry.startsWith("comment:")), ["resolved", "staged", "push", "verify"]);
    assert.ok(!order.includes("blocked") && !order.includes("abort") && !order.includes("discard"));
    assert.equal(f.state.getJob(42)?.status, "pr_open");
    assert.match(f.state.getJob(42)?.lastError ?? "", /401/);
  } finally {
    f.state.close();
    await rm(root, { recursive: true, force: true });
  }
});
