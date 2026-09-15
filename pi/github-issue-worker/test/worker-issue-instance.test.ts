import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppInstance } from "../src/app-instance/index.js";
import type { GitHubClient } from "../src/github.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import type { RepositoryManager } from "../src/repository.js";
import { WorkerState } from "../src/state.js";
import { config, issue, TestIssueWorker as IssueWorker } from "./helpers/worker-fixtures.js";

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// The manifest declares a launcher, so: the implementer only implements (no capture during the run), the
// controller starts one instance, the visual stage and the verifier both use it, and it is stopped last.
test("with a manifest launch the implementer does not capture; visual QA and the verifier share one instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-issue-instance-"));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".pi-worker"), { recursive: true });
  await writeFile(
    join(worktree, ".pi-worker", "qa.json"),
    JSON.stringify({ version: 1, launch: { argv: ["./run.sh"] }, readiness: { endpoints: { frontend: "http://localhost:3005" } } }),
  );
  const state = new WorkerState(join(root, "state.sqlite"));
  const uiIssue = { ...issue, labels: [{ name: "pi-ready" }, { name: "pi-visual" }] };
  const log: string[] = [];
  const prompts: string[] = [];
  const instance: AppInstance = {
    dir: "/i", runId: "r", fingerprint: "f", endpoints: { frontend: "http://localhost:3005" }, storageState: null, readinessMs: 1,
    environment: () => ({ PI_QA_INSTANCE: "/i" }),
    ensureCurrent: async () => { log.push("ensure"); return false; },
    stop: async () => { log.push("stop"); },
  };
  const github = {
    listReadyIssues: async () => [uiIssue],
    claimIssue: async () => undefined,
    findOpenPullRequest: async () => null,
    createDraftPullRequest: async () => ({ number: 9, url: "https://github.com/example/widgets/pull/9" }),
    labelPullRequestFromIssue: async () => undefined,
    markPullRequestOpen: async () => undefined,
    commentIssue: async () => undefined,
    markBlocked: async () => { log.push("blocked"); },
    getIssue: async () => uiIssue,
    isPullRequestOpen: async () => true,
    listFeedback: async () => [],
    getPullRequestChecks: async () => ({ headSha: "h", state: "pending", failures: [] }),
  };
  let implemented = false;
  const repository = {
    branchForIssue: () => "pi/issue-42",
    pathForIssue: () => worktree,
    ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: worktree }),
    changedFiles: async () => (implemented ? ["frontend/app/page.tsx"] : []),
    hasCommitsAhead: async () => false,
    commitAndPush: async () => ({ commit: "h", files: ["frontend/app/page.tsx"] }),
    pushIfAhead: async () => undefined,
    headRevision: async () => "h",
    clearAgentChanges: async () => undefined,
  };
  const agent = {
    run: async (options: { prompt: string; visualVerification?: boolean; environment?: NodeJS.ProcessEnv }) => {
      prompts.push(options.prompt);
      if (options.visualVerification) {
        log.push(`visual:${options.environment?.PI_QA_INSTANCE}`);
        const evidenceDir = /Evidence directory: (\S+)/.exec(options.prompt)?.[1];
        assert.ok(evidenceDir, "the visual stage names its evidence directory");
        await mkdir(join(worktree, evidenceDir), { recursive: true });
        await writeFile(join(worktree, evidenceDir, "desktop.png"), validPng);
        await writeFile(join(worktree, evidenceDir, "mobile.png"), validPng);
      } else {
        log.push("implement");
        implemented = true;
      }
      return { sessionFile: join(root, "session.jsonl"), finalText: "Done." };
    },
  };
  const qaVerifier = {
    verify: async (_issue: unknown, _worktree: string, _plan: unknown, options?: { instance?: AppInstance | null }) => {
      log.push(`verify:${options?.instance ? "instance" : "none"}`);
      return "/private/qa/result.json";
    },
  };
  try {
    const worker = new IssueWorker(config(root), state, {
      github: github as unknown as GitHubClient,
      repository: repository as unknown as RepositoryManager,
      agent: agent as unknown as PiAgentRunner,
      qaVerifier,
      appInstances: { start: async () => { log.push("start"); return instance; } },
    });
    await worker.tick();
    assert.equal(state.requireJob(42).status, "pr_open", state.requireJob(42).lastError ?? "");
    assert.deepEqual(log, ["implement", "start", "ensure", "visual:/i", "ensure", "verify:instance", "stop"]);
    assert.doesNotMatch(prompts[0] ?? "", /Visual verification is requested/);
    assert.match(prompts[1] ?? "", /already running for this run/);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
