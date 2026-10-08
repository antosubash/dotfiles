import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeCommandProcessGroupPath, createBashOperations, stopTrackedProcessGroup } from "../src/agent/process-group.js";

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

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Codemode scripts run bash calls with Promise.all: each call must be tracked, and aborting one must not
// kill its sibling.
test("parallel bash calls are tracked together and abort independently", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-parallel-bash-"));
  try {
    const activeFile = activeCommandProcessGroupPath(root);
    const operations = createBashOperations(activeFile, { sandbox: false });
    const firstPid = join(root, "first.pid");
    const secondPid = join(root, "second.pid");
    const release = join(root, "release");
    const controller = new AbortController();
    const first = operations.exec(`echo $$ > ${JSON.stringify(firstPid)}; sleep 30`, root, {
      onData: () => undefined, signal: controller.signal, timeout: 30,
    });
    const second = operations.exec(
      `echo $$ > ${JSON.stringify(secondPid)}; for _ in $(seq 600); do [ -f ${JSON.stringify(release)} ] && exit 0; sleep 0.05; done; exit 1`,
      root,
      { onData: () => undefined, timeout: 30 },
    );
    await Promise.all([waitForPath(firstPid), waitForPath(secondPid)]);
    const pids = await Promise.all([firstPid, secondPid].map(async (path) => Number.parseInt(await readFile(path, "utf8"), 10)));
    const tracked = (await readFile(activeFile, "utf8")).trim().split("\n").map(Number).sort();
    assert.deepEqual(tracked, [...pids].sort());

    controller.abort();
    await assert.rejects(first, /aborted/);
    assert.equal(groupAlive(pids[0]!), false);
    assert.equal(groupAlive(pids[1]!), true, "aborting one call must not kill its sibling");
    assert.equal((await readFile(activeFile, "utf8")).trim(), String(pids[1]));

    await writeFile(release, "");
    assert.equal((await second).exitCode, 0);
    await assert.rejects(access(activeFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping tracked groups kills every recorded group", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-parallel-stop-"));
  try {
    const activeFile = activeCommandProcessGroupPath(root);
    const children = [0, 1].map(() => spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" }));
    const pids = children.map((child) => child.pid!);
    children.forEach((child) => child.unref());
    await writeFile(activeFile, pids.map((pid) => `${pid}\n`).join(""));

    await stopTrackedProcessGroup(activeFile);

    for (const pid of pids) assert.equal(groupAlive(pid), false);
    await assert.rejects(access(activeFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
