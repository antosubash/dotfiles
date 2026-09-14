import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cgroupController, ownCgroupPath, wrapInCgroup } from "../src/agent/cgroup.js";

test("ownCgroupPath maps the v2 line of /proc/self/cgroup under the sysfs root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cgroup-"));
  const proc = join(root, "cgroup");
  await writeFile(proc, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi.service\n");
  assert.equal(
    ownCgroupPath(proc, "/sys/fs/cgroup"),
    "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/pi.service",
  );
  await writeFile(proc, "12:memory:/legacy\n");
  assert.equal(ownCgroupPath(proc, "/sys/fs/cgroup"), null);
  assert.equal(ownCgroupPath(join(root, "missing"), "/sys/fs/cgroup"), null);
  await rm(root, { recursive: true, force: true });
});

test("an unavailable controller is a no-op that never throws", async () => {
  const controller = cgroupController(null);
  assert.equal(controller.available(), false);
  assert.equal(await controller.createChild("bash-1"), null);
  assert.deepEqual(await controller.sweepChildren(["bash-", "qa-"]), []);
  await controller.killAndRemove("/nonexistent/child");
  assert.deepEqual(wrapInCgroup(null, ["bash", "-c", "true"]), ["bash", "-c", "true"]);
});

test("a controller rooted at a plain directory creates, lists and removes children (kill file is written)", async () => {
  // A temp dir stands in for the worker's cgroup: cgroup.procs/cgroup.kill are ordinary files here, which
  // is enough to prove the bookkeeping; the real kill is covered by the opt-in smoke test below.
  const root = await mkdtemp(join(tmpdir(), "pi-cgroup-root-"));
  await writeFile(join(root, "cgroup.kill"), "");
  const controller = cgroupController(root);
  assert.equal(controller.available(), true);
  const child = await controller.createChild("bash-7");
  assert.equal(child, join(root, "bash-7"));
  await writeFile(join(child!, "cgroup.procs"), "");
  await writeFile(join(child!, "cgroup.kill"), "");
  assert.deepEqual(await controller.procs(child!), []);
  await controller.killAndRemove(child!);
  assert.equal(await readFile(join(root, "bash-7", "cgroup.procs"), "utf8").catch(() => "gone"), "gone");
  for (const name of ["bash-1", "qa-abc", "other"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "cgroup.procs"), "");
    await writeFile(join(root, name, "cgroup.kill"), "");
  }
  assert.deepEqual((await controller.sweepChildren(["bash-", "qa-"])).sort(), ["bash-1", "qa-abc"]);
  await rm(root, { recursive: true, force: true });
});

test("wrapInCgroup moves the shell into the child before exec", () => {
  const argv = wrapInCgroup("/sys/fs/cgroup/x/bash-1", ["bash", "-c", "echo hi"]);
  assert.equal(argv[0], "sh");
  assert.match(argv[2], /echo \$\$ > "\$1\/cgroup\.procs"/);
  assert.match(argv[2], /exec "\$@"/);
  assert.deepEqual(argv.slice(3), ["sh", "/sys/fs/cgroup/x/bash-1", "bash", "-c", "echo hi"]);
});

// Real kill: needs a writable cgroup, i.e. a systemd user unit. Run with
//   PI_WORKER_CGROUP_SMOKE=1 systemd-run --user --collect --wait --pipe -p Delegate=yes \
//     --working-directory=$PWD -E PATH=$PATH -E HOME=$HOME npx tsx --test test/cgroup.test.ts
test(
  "a setsid tree inside a child cgroup is killed by killAndRemove",
  { skip: process.env.PI_WORKER_CGROUP_SMOKE !== "1" },
  async () => {
    const controller = cgroupController(ownCgroupPath());
    assert.equal(controller.available(), true);
    const child = (await controller.createChild("test-smoke"))!;
    const [command, ...args] = wrapInCgroup(child, ["bash", "-c", "setsid bash -c 'sleep 300 & sleep 300 & wait' & sleep 300"]);
    const proc = spawn(command, args, { stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok((await controller.procs(child)).length >= 3);
    await controller.killAndRemove(child);
    assert.deepEqual(await controller.procs(child).catch(() => []), []);
    proc.kill("SIGKILL");
  },
);
