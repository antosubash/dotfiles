import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CgroupController } from "../src/agent/cgroup.js";
import { activeCommandProcessGroupPath, createBashOperations } from "../src/agent/process-group.js";

/** A controller over a plain directory: cgroup.procs/cgroup.kill are ordinary files, `procs` is scripted. */
function fakeController(root: string, procs: () => number[]): CgroupController & { created: string[]; killed: number } {
  const controller = {
    root,
    created: [] as string[],
    killed: 0,
    available: () => true,
    async createChild(name: string) {
      const dir = join(root, name);
      await mkdir(dir);
      await writeFile(join(dir, "cgroup.procs"), "");
      controller.created.push(name);
      return dir;
    },
    procs: async () => procs(),
    async killAndRemove(dir: string) {
      controller.killed += 1;
      await rm(dir, { recursive: true, force: true });
    },
    sweepChildren: async () => [],
  };
  return controller;
}

test("agent bash never reuses MSBuild nodes or the msbuild server", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-bash-tooling-"));
  try {
    const operations = createBashOperations(activeCommandProcessGroupPath(root), { sandbox: false });
    const chunks: string[] = [];
    await operations.exec('printf "%s %s" "$MSBUILDNODEREUSE" "$DOTNET_CLI_USE_MSBUILD_SERVER"', root, { onData: (data) => chunks.push(String(data)), timeout: 30 });
    assert.equal(chunks.join(""), "0 0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a per-run environment reaches the command", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-bash-env-"));
  try {
    const operations = createBashOperations(activeCommandProcessGroupPath(root), {
      sandbox: false,
      environmentOverrides: { PI_QA_INSTANCE: "/tmp/i", PI_QA_ENDPOINT_FRONTEND: "http://localhost:3005" },
    });
    const chunks: string[] = [];
    await operations.exec('printf "%s %s" "$PI_QA_INSTANCE" "$PI_QA_ENDPOINT_FRONTEND"', root, { onData: (data) => chunks.push(String(data)), timeout: 30 });
    assert.equal(chunks.join(""), "/tmp/i http://localhost:3005");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The shim writes the shell's pid into the child's cgroup.procs before exec; with a plain directory that
// write succeeds and proves the wiring without needing a real cgroup.
test("each bash call gets its own child cgroup and it is removed afterwards", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-bash-cg-"));
  try {
    const cgroups = fakeController(root, () => []);
    const operations = createBashOperations(activeCommandProcessGroupPath(root), { sandbox: false, cgroups });
    const chunks: string[] = [];
    await operations.exec("echo one", root, { onData: (data) => chunks.push(String(data)), timeout: 30 });
    await operations.exec("echo two", root, { onData: (data) => chunks.push(String(data)), timeout: 30 });
    assert.equal(chunks.join(""), "one\ntwo\n");
    assert.deepEqual(cgroups.created, ["bash-1", "bash-2"]);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("bash-")), []);
    assert.equal(cgroups.killed, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a child cgroup an earlier run could not remove is skipped, never reused", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-bash-cg-stale-"));
  try {
    await mkdir(join(root, "bash-1"));
    const cgroups = fakeController(root, () => []);
    const operations = createBashOperations(activeCommandProcessGroupPath(root), { sandbox: false, cgroups });
    await operations.exec("true", root, { onData: () => undefined, timeout: 30 });
    assert.deepEqual(cgroups.created, ["bash-2"]);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("bash-")), ["bash-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processes still alive in the call's cgroup reject the call after a cgroup kill", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-bash-cg-left-"));
  try {
    let killed = false;
    const cgroups = fakeController(root, () => (killed ? [] : [4242]));
    const original = cgroups.killAndRemove;
    cgroups.killAndRemove = async (dir: string) => { killed = true; await original(dir); };
    const operations = createBashOperations(activeCommandProcessGroupPath(root), { sandbox: false, cgroups });
    await assert.rejects(operations.exec("true", root, { onData: () => undefined, timeout: 30 }), /left background processes running/);
    assert.equal(killed, true);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("bash-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
