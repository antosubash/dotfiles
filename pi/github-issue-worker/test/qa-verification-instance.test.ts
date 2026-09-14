import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppInstance } from "../src/app-instance/index.js";
import { loadConfig } from "../src/config.js";
import { execFile } from "../src/exec.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import { QaVerificationService } from "../src/qa-verification.js";
import type { GitHubIssue } from "../src/types.js";

const issue: GitHubIssue = {
  number: 7, title: "Fix the settings dialog layout", body: "The dialog overflows on mobile.",
  url: "https://github.com/example/repo/issues/7", updatedAt: "now", labels: [], author: { login: "owner" },
};

test("verify hands the running instance to the agent's environment and prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-qa-instance-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const git = (args: string[]) => execFile("git", args, { cwd: worktree });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await writeFile(join(worktree, "page.tsx"), "export const Page = () => null;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const config = loadConfig({ HOME: root, PI_WORKER_REPOSITORY: "example/repo", PI_WORKER_BASE_BRANCH: "main", PI_WORKER_DATA_DIR: join(root, "data") });
  let seen: { prompt: string; environment?: NodeJS.ProcessEnv; visualVerification?: boolean } | null = null;
  const agent: Pick<PiAgentRunner, "run"> = {
    run: async (options) => {
      seen = options;
      return { sessionFile: join(options.sessionDir, "qa.jsonl"), finalText: "{}" };
    },
  };
  const instance: AppInstance = {
    dir: "/i", runId: "r", fingerprint: "f", readinessMs: 1_500, storageState: "/i/storage-state.json",
    endpoints: { frontend: "http://localhost:3005" },
    environment: () => ({ PI_QA_INSTANCE: "/i", PI_QA_ENDPOINT_FRONTEND: "http://localhost:3005", PI_QA_STORAGE_STATE: "/i/storage-state.json" }),
    ensureCurrent: async () => false,
    stop: async () => undefined,
  };
  try {
    await new QaVerificationService(config, agent).verify(issue, worktree, null, { instance }).catch(() => undefined);
    assert.ok(seen, "the verifier ran the agent");
    const run = seen as unknown as { prompt: string; environment?: NodeJS.ProcessEnv; visualVerification?: boolean };
    assert.equal(run.visualVerification, true);
    assert.equal(run.environment?.PI_QA_ENDPOINT_FRONTEND, "http://localhost:3005");
    assert.match(run.prompt, /already running for this run/);
    assert.match(run.prompt, /state-load \/i\/storage-state\.json/);
    assert.doesNotMatch(run.prompt, /A backend or service that is merely not running is not an unavailable dependency/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
