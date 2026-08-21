import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  activeCommandProcessGroupPath,
  createSandboxedBashOperations,
} from "../src/pi-agent.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  cleanupSupervisorProfileProcessGroup,
  isMainModule,
} from "../src/supervisor.js";

async function waitForPath(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

test("supervisor main detection follows an installed bin symlink", async (context) => {
  if (platform() === "win32") context.skip("File symlink creation may require elevation on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-main-"));
  try {
    const link = join(root, "pi-issue-worker-supervisor");
    await symlink(fileURLToPath(new URL("../src/supervisor.ts", import.meta.url)), link);
    assert.equal(isMainModule(link), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandboxed bash abort kills the detached descendant process group", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-process-group-"));
  try {
    const activeFile = activeCommandProcessGroupPath(root);
    const pidFile = join(root, "shell.pid");
    const sandboxManager = SandboxManager as unknown as {
      wrapWithSandbox: (command: string) => Promise<string>;
    };
    const previousWrap = sandboxManager.wrapWithSandbox;
    sandboxManager.wrapWithSandbox = async (command) => command;
    try {
      const operations = createSandboxedBashOperations(activeFile);
      const controller = new AbortController();
      const execution = operations.exec(
        `echo $$ > ${JSON.stringify(pidFile)}; sleep 30`,
        root,
        { onData: () => undefined, signal: controller.signal, timeout: 30 },
      );

      await waitForPath(pidFile);
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (!Number.isInteger(pid)) throw new Error("Shell pid file did not contain a numeric pid");
      assert.doesNotThrow(() => process.kill(-pid, 0));

      controller.abort();
      await assert.rejects(execution, /aborted/);
      await assert.rejects(access(activeFile));
      assert.throws(() => process.kill(-pid, 0), (error: any) => error?.code === "ESRCH");
    } finally {
      sandboxManager.wrapWithSandbox = previousWrap;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandboxed bash rejects when the leader dies but a descendant survives", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-process-group-leader-"));
  try {
    const activeFile = activeCommandProcessGroupPath(root);
    const leaderPidFile = join(root, "leader.pid");
    const descendantPidFile = join(root, "descendant.pid");
    const sandboxManager = SandboxManager as unknown as {
      wrapWithSandbox: (command: string) => Promise<string>;
    };
    const previousWrap = sandboxManager.wrapWithSandbox;
    sandboxManager.wrapWithSandbox = async (command) => command;
    try {
      const operations = createSandboxedBashOperations(activeFile);
      const execution = operations.exec(
        [
          `echo $$ > ${JSON.stringify(leaderPidFile)}`,
          `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(descendantPidFile)}`,
          "kill -9 $$",
        ].join("; "),
        root,
        { onData: () => undefined, timeout: 30 },
      );

      await waitForPath(leaderPidFile);
      await waitForPath(descendantPidFile);
      const leaderPid = Number.parseInt(await readFile(leaderPidFile, "utf8"), 10);
      const descendantPid = Number.parseInt(await readFile(descendantPidFile, "utf8"), 10);
      if (!Number.isInteger(leaderPid)) throw new Error("Leader pid file did not contain a numeric pid");
      if (!Number.isInteger(descendantPid)) throw new Error("Descendant pid file did not contain a numeric pid");

      await assert.rejects(execution, /SIGKILL/);
      await assert.rejects(access(activeFile));
      assert.throws(() => process.kill(leaderPid, 0), (error: any) => error?.code === "ESRCH");
      assert.throws(() => process.kill(descendantPid, 0), (error: any) => error?.code === "ESRCH");
      assert.throws(() => process.kill(-leaderPid, 0), (error: any) => error?.code === "ESRCH");
    } finally {
      sandboxManager.wrapWithSandbox = previousWrap;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor cleanup stops a recorded descendant process group before reuse", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-group-"));
  try {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const config = loadConfig({
      HOME: root,
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_DATA_DIR: dataDir,
    });
    const profile = {
      name: "widgets",
      path: join(root, "widgets.env"),
      env: {},
      config,
    };
    const activeFile = activeCommandProcessGroupPath(dataDir);
    const child = spawn("bash", ["-lc", "sleep 30"], { detached: true, stdio: "ignore" });
    const pid = child.pid;
    if (!pid) throw new Error("Detached child did not expose a pid");
    writeFileSync(activeFile, `${pid}\n`, "utf8");
    child.unref();
    assert.doesNotThrow(() => process.kill(-pid, 0));

    await cleanupSupervisorProfileProcessGroup(profile);

    assert.throws(() => process.kill(-pid, 0), (error: any) => error?.code === "ESRCH");
    await assert.rejects(access(activeFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
