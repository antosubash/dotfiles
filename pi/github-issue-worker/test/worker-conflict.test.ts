import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

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
    getIssue: async () => issue,
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
    stageBaseMerge: async () => undefined,
    finishBaseMerge: async () => {
      finished += 1;
    },
    abortBaseMerge: async () => undefined,
  };
  const agent = {
    run: async (options: { prompt: string; sessionFile: string | null }) => {
      runs += 1;
      assert.match(options.prompt, /Resolve merge conflicts/);
      // #501 attempts 3 and 5: a resumed session "remembered" a discarded resolution; checks ran on a stale install.
      for (const rule of [/contain conflict markers RIGHT NOW/, /that work was discarded by the controller/, /documented install\/restore/]) assert.match(options.prompt, rule);
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
    getIssue: async () => issue,
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
    stageBaseMerge: async () => undefined,
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

// The agent resolves conflicts in the working tree only (git add is policy-blocked), so until the controller
// stages the result the index still carries UU entries. The independent verifier reads `git status` as part
// of its diff review and fails on exactly that, so staging has to come before verification, not after.
test("a conflict resolution is staged before the QA gate runs and committed after it passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-order-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  const order: string[] = [];
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "feature-head", baseSha: "base-head", baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => undefined,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    beginBaseMerge: async () => ({ baseSha: "base-head", conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true }),
    stageBaseMerge: async () => { order.push("staged"); },
    finishBaseMerge: async () => { order.push("committed"); },
    abortBaseMerge: async () => { order.push("aborted"); },
  };
  const agent = { run: async () => { order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
      qaVerifier: { verify: async () => { order.push("verified"); return "/private/qa/result.json"; } },
    });
    await worker.tick();
    assert.deepEqual(order, ["resolved", "staged", "verified", "committed"]);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

// `git merge --abort` restores the merge itself but keeps unstaged edits the agent made to auto-merged
// files, and beginBaseMerge refuses to merge onto a dirty worktree — so once a resolution failed, every
// retry died with "Cannot update from origin/dev with existing worktree changes" (IIASA.GeoWiki#501).
// Abandoning a resolution has to mean discarding it completely, ignored build outputs excepted.
test("a failed conflict resolution is discarded from the worktree so a retry can merge again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-discard-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  const order: string[] = [];
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "feature-head", baseSha: "base-head", baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async () => undefined,
    markBlocked: async () => { order.push("blocked"); },
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    beginBaseMerge: async () => ({ baseSha: "base-head", conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true }),
    stageBaseMerge: async () => { order.push("staged"); },
    finishBaseMerge: async () => { order.push("committed"); },
    abortBaseMerge: async () => { order.push("aborted"); },
    clearAgentChanges: async (_worktree: string, _branch: string, options?: { ignored?: boolean }) => {
      order.push(`discarded(ignored=${String(options?.ignored ?? true)})`);
    },
  };
  const agent = { run: async () => { order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
      qaVerifier: { verify: async () => { throw new Error("Independent QA BLOCKED: backend unavailable"); } },
    });
    await worker.tick();
    assert.deepEqual(order, ["resolved", "staged", "aborted", "discarded(ignored=false)", "blocked"]);
    assert.match(state.getJob(42)?.lastError ?? "", /conflict resolution failed/);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A conflict block is keyed on the PR's head and base OIDs, and GitHub's baseRefOid only moves when the PR
// syncs — so once processed, the resolution never re-ran and the documented `/pi retry` only knew about CI
// blocks. Retrying a conflict block must re-queue the resolution (next tick), not send the agent "retry".
test("trusted /pi retry on a conflict-blocked PR re-queues the base-branch resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-retry-"));
  const state = new WorkerState(join(root, "state.sqlite"));
  state.claim(issue, "pi/issue-42", join(root, "worktree"), false);
  state.setPullRequest(42, 77, "https://github.com/example/widgets/pull/77");
  state.setStatus(42, "pr_open", "Automatic base-branch conflict resolution failed: Independent QA gate: fixture");
  state.markProcessed(42, "merge-conflict:77:main:feature-head:base-head");
  const order: string[] = [];
  const github = {
    getIssue: async () => issue,
    listReadyIssues: async () => [],
    isPullRequestOpen: async () => true,
    getPullRequestMergeState: async () => ({
      headSha: "feature-head", baseSha: "base-head", baseBranch: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
    }),
    markPullRequestOpen: async () => undefined,
    commentPullRequest: async (_pr: number, body: string) => { order.push(`comment:${body.slice(0, 40)}`); },
    markBlocked: async () => undefined,
    listFeedback: async () => [{
      eventKey: "conversation:retry-conflict", source: "conversation", id: 11, body: "/pi retry", author: "maintainer",
      authorAssociation: "MEMBER", createdAt: "2026-01-02T00:00:00Z", url: null,
    }],
    getPullRequestChecks: async () => ({ headSha: "feature-head", state: "pending", failures: [] }),
  };
  const repository = {
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: join(root, "worktree") }),
    headRevision: async () => "feature-head",
    beginBaseMerge: async () => { order.push("merge-begun"); return { baseSha: "base-head", conflicts: ["src/form.ts"], alreadyCurrent: false, mergeInProgress: true }; },
    stageBaseMerge: async () => undefined,
    finishBaseMerge: async () => { order.push("committed"); },
    abortBaseMerge: async () => undefined,
    clearAgentChanges: async () => undefined,
  };
  const agent = { run: async () => { order.push("resolved"); return { sessionFile: join(root, "session.jsonl"), finalText: "Resolved." }; } };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
    });
    await worker.tick();
    assert.equal(order.length, 1);
    assert.match(order[0]!, /^comment:🔄 Base-branch conflict resolution retry/);
    assert.equal(state.hasProcessed("merge-conflict:77:main:feature-head:base-head"), false);
    assert.equal(state.hasProcessed("conversation:retry-conflict"), true);
    await worker.tick();
    assert.deepEqual(order.slice(1, 4), ["merge-begun", "resolved", "committed"]);
    assert.match(order[4] ?? "", /^comment:🔀 Base-branch conflicts resolved/);
    assert.equal(order.length, 5);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
