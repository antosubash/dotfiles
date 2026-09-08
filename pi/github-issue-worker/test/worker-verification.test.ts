import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { IssuePlan } from "../src/issue-plan.js";

const baseIssue: GitHubIssue = { number: 42, title: "Add behavior", body: "Acceptance criteria", url: "https://github.com/example/repo/issues/42", updatedAt: "now", labels: [{ name: "pi-ready" }], author: { login: "owner" } };
const plan: IssuePlan = { schemaVersion: 1, issueNumber: 42, issueHash: "a".repeat(64), sourceFingerprint: "b".repeat(64), implementationSteps: ["Implement behavior"], checks: [{ id: "P1", kind: "behavioral", requirement: "Acceptance", steps: ["test"], expected: "Result" }] };

async function harness(options: { figma?: boolean; qaFail?: boolean; designFail?: boolean; planning?: boolean; savedPlan?: boolean; planLabel?: string; feedback?: boolean; ciFailed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-gates-flow-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  const issue = { ...baseIssue, body: options.figma ? "figma.com/design/Key/Test?node-id=1-2" : baseIssue.body,
    labels: options.planLabel ? [...baseIssue.labels, { name: options.planLabel }] : baseIssue.labels };
  const config = loadConfig({ HOME: root, PI_WORKER_REPOSITORY: "example/repo", PI_WORKER_BASE_BRANCH: "main", PI_WORKER_DATA_DIR: join(root, "data") });
  const calls: string[] = []; let dirty = false;
  const feedback: PullRequestFeedback = { eventKey: "conversation:1", source: "conversation", id: 1, body: "/pi fix behavior", author: "owner", authorAssociation: "OWNER", createdAt: "now", url: null };
  const github = {
    listReadyIssues: async () => [issue], listPlanningIssues: async () => options.planning ? [issue] : [],
    finishPlanning: async (_number: number, body: string) => { calls.push("plan-report"); assert.match(body, /No implementation/); },
    claimIssue: async () => { calls.push("claim"); }, findOpenPullRequest: async () => null,
    createDraftPullRequest: async () => { calls.push("pr"); return { number: 77, url: "https://github.com/example/repo/pull/77" }; },
    labelPullRequestFromIssue: async () => {}, markPullRequestOpen: async () => {},
    commentIssue: async () => {}, commentPullRequest: async () => {}, markBlocked: async () => { calls.push("blocked"); },
    getIssue: async () => issue, isPullRequestOpen: async () => true, listFeedback: async () => options.feedback ? [feedback] : [],
    getPullRequestChecks: async () => ({ headSha: "head", state: options.ciFailed ? "failed" : "pending", failures: [] }),
  };
  const repository = {
    branchForIssue: () => "pi/issue-42", pathForIssue: () => join(root, "worktree"),
    ensureIssueWorktree: async () => ({ path: join(root, "worktree"), branch: "pi/issue-42" }),
    changedFiles: async () => dirty ? ["backend/change.py"] : [], hasCommitsAhead: async () => false,
    hasUnpushedCommits: async () => true, headRevision: async () => "head",
    commitAndPush: async () => { calls.push("push"); }, pushIfAhead: async () => { calls.push("push"); },
    clearAgentChanges: async () => { dirty = false; calls.push("cleanup"); },
  };
  const worker = new IssueWorker(config, state, {
    github: github as unknown as GitHubClient, repository: repository as unknown as RepositoryManager,
    agent: { run: async (run: { prompt: string }) => { calls.push("implement"); dirty = true;
      if (options.savedPlan) assert.match(run.prompt, /Saved pi-plan/);
      return { sessionFile: join(root, "worker.jsonl"), finalText: "Implemented" }; } } as unknown as PiAgentRunner,
    plans: { load: async () => options.savedPlan ? plan : null, create: async () => { calls.push("plan"); return plan; } },
    qaVerifier: { verify: async (original, _worktree, saved) => {
      calls.push("qa"); assert.equal(original.body, issue.body); assert.equal(saved, options.savedPlan ? plan : null);
      if (options.qaFail) throw new Error("Independent QA FAILED: acceptance did not pass"); return "/private/qa.json";
    } },
    designVerifier: { verify: async () => { calls.push("design"); if (options.designFail) throw new Error("Figma FAILED: typography mismatch"); return options.figma ? "/private/design.json" : null; } },
  });
  return { worker, state, calls, issue, root, cleanup: async () => { state.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const savedPlan of [false, true]) test(`ordinary issues require independent QA before push (saved plan=${savedPlan})`, async () => {
  const h = await harness({ savedPlan });
  try { await h.worker.tick(); assert.deepEqual(h.calls, ["claim", "implement", "qa", "design", "push", "pr"]); }
  finally { await h.cleanup(); }
});

for (const failure of ["qa", "design"] as const) test(`${failure} failure prevents initial push and PR`, async () => {
  const h = await harness({ figma: true, qaFail: failure === "qa", designFail: failure === "design" });
  try {
    await h.worker.tick(); assert.equal(h.state.requireJob(42).status, "blocked");
    assert.ok(h.calls.includes(failure)); assert.ok(!h.calls.includes("push")); assert.ok(!h.calls.includes("pr"));
    if (failure === "qa") assert.ok(!h.calls.includes("design"));
  } finally { await h.cleanup(); }
});

test("pi-plan label wins over simultaneous pi-ready and invokes no implementation or QA", async () => {
  const h = await harness({ planning: true });
  try { await h.worker.tick(); assert.deepEqual(h.calls, ["plan", "plan-report"]); assert.equal(h.state.getJob(42), null); }
  finally { await h.cleanup(); }
});

for (const planLabel of ["pi-plan", "PI-PLAN"]) test(`planning label ${planLabel} omitted from the bounded planning page cannot enter implementation`, async () => {
  const h = await harness({ planLabel });
  try { await h.worker.tick(); assert.deepEqual(h.calls, []); assert.equal(h.state.getJob(42), null); }
  finally { await h.cleanup(); }
});

for (const kind of ["ci", "feedback"] as const) test(`${kind} interrupted push recovery re-runs independent QA and blocks failed acceptance`, async () => {
  const h = await harness({ qaFail: true, feedback: kind === "feedback", ciFailed: kind === "ci" });
  try {
    h.state.claim(h.issue, "pi/issue-42", join(h.root, "worktree"), false);
    h.state.setPullRequest(42, 77, "https://github.com/example/repo/pull/77");
    if (kind === "ci") {
      h.state.setCiHead(42, "head");
      h.state.setStatus(42, "committing_ci");
    } else h.state.setStatus(42, "addressing_review");
    await h.worker.tick();
    assert.ok(h.calls.includes("qa")); assert.ok(h.calls.includes("blocked"));
    assert.ok(!h.calls.includes("implement")); assert.ok(!h.calls.includes("push"));
  } finally { await h.cleanup(); }
});
