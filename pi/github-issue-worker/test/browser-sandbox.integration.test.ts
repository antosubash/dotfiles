import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { loadConfig } from "../src/config.js";
import { convertWebmToGif } from "../src/evidence.js";
import { sandboxConfig } from "../src/pi-agent.js";

const enabled = process.env.PI_WORKER_BROWSER_SMOKE === "1";

test(
  "visual sandbox launches and closes a stateful Playwright CLI browser",
  { skip: enabled ? false : "set PI_WORKER_BROWSER_SMOKE=1 to run the installed-browser smoke test" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-worker-browser-smoke-"));
    const worktree = join(root, "worktree");
    const runtimeRoot = `/run/user/${process.getuid?.()}`;
    const privateTemp = await mkdtemp(join(runtimeRoot, "piw-"));
    await mkdir(worktree);
    const config = loadConfig({
      ...process.env,
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_DATA_DIR: join(root, "data"),
    });
    const previous = process.env.CLAUDE_CODE_TMPDIR;
    const previousTmpdir = process.env.TMPDIR;
    const previousPlaywrightDaemonDir = process.env.PLAYWRIGHT_DAEMON_SESSION_DIR;
    process.env.CLAUDE_CODE_TMPDIR = privateTemp;
    process.env.TMPDIR = privateTemp;
    process.env.PLAYWRIGHT_DAEMON_SESSION_DIR = join(privateTemp, "playwright-daemon");
    try {
      await SandboxManager.initialize(
        sandboxConfig(worktree, config, { privateTemp, visualVerification: true }),
      );
      const session = `pi-worker-smoke-${process.pid}`;
      const screenshot = join(worktree, "smoke.png");
      const webm = join(worktree, "workflow.webm");
      const gif = join(worktree, "workflow.gif");
      const command = [
        `trap 'playwright-cli -s ${session} close >/dev/null 2>&1 || true' EXIT`,
        "curl --fail --silent --show-error https://api.github.com/rate_limit >/dev/null",
        `playwright-cli -s ${session} open about:blank`,
        `playwright-cli -s ${session} snapshot`,
        `playwright-cli -s ${session} screenshot --filename=${JSON.stringify(screenshot)}`,
        `playwright-cli -s ${session} video-start ${JSON.stringify(webm)}`,
        `playwright-cli -s ${session} goto 'data:text/html,<button>recorded</button>'`,
        `playwright-cli -s ${session} video-stop`,
        `playwright-cli -s ${session} close`,
      ].join(" && ");
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(wrapped, {
          cwd: worktree,
          env: process.env,
          shell: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
      assert.equal(result.code, 0, result.stderr);
      assert.ok((await stat(screenshot)).size > 0);
      assert.ok((await stat(webm)).size > 0);
      await convertWebmToGif(webm, gif);
      assert.ok((await stat(gif)).size > 0);
    } finally {
      await SandboxManager.reset();
      if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previous;
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      if (previousPlaywrightDaemonDir === undefined) {
        delete process.env.PLAYWRIGHT_DAEMON_SESSION_DIR;
      } else {
        process.env.PLAYWRIGHT_DAEMON_SESSION_DIR = previousPlaywrightDaemonDir;
      }
      await rm(root, { recursive: true, force: true });
      await rm(privateTemp, { recursive: true, force: true });
    }
  },
);
