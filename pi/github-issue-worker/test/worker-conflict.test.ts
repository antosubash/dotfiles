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
