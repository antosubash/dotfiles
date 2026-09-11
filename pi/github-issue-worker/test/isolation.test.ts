import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { loadConfig } from "../src/config.js";
import { openIsolation } from "../src/agent/isolation.js";

function workerConfig(root: string, sandbox: boolean) {
  return loadConfig({
    HOME: root,
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
    PI_WORKER_DATA_DIR: join(root, "data"),
    PI_WORKER_SANDBOX: sandbox ? "1" : "0",
  });
}

/** Records every SandboxManager entry point so a test can prove none (or all) were used. */
function spySandboxManager(): { calls: string[]; restore: () => void } {
  const manager = SandboxManager as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const calls: string[] = [];
  const previous = { initialize: manager.initialize, reset: manager.reset, wrapWithSandbox: manager.wrapWithSandbox };
  manager.initialize = async () => { calls.push("initialize"); };
  manager.reset = async () => { calls.push("reset"); };
  manager.wrapWithSandbox = async (command: unknown) => { calls.push("wrap"); return `bwrap --unshare-net --tmpfs /tmp --tmpfs /var -- ${String(command)}`; };
  return { calls, restore: () => { Object.assign(manager, previous); } };
}

// With sandboxing off the runner must not touch the sandbox runtime at all — not even to initialize it —
// while still giving the run a private temp directory (bash tool scratch, Playwright daemon) under /tmp and
// tearing it down on close. This is the whole contract that lets a repository stack start unsandboxed.
test("openIsolation runs without the sandbox runtime when config.sandbox is false", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-isolation-off-"));
  const spy = spySandboxManager();
  const previousTmpdir = process.env.TMPDIR;
  const previousOutputDir = process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;
  try {
    const isolation = await openIsolation(workerConfig(root, false), {
      worktree: root,
      processGroupFile: join(root, "active.pid"),
      visualVerification: true,
      dockerAccess: false,
      shutdownSignal: new AbortController().signal,
    });
    assert.equal(isolation.sandboxed, false);
    assert.equal(dirname(isolation.privateTemp), "/tmp");
    await access(join(isolation.privateTemp, ".owner-pid"));
    assert.equal((await readFile(join(isolation.privateTemp, ".owner-pid"), "utf8")).trim(), String(process.pid));
    assert.equal(process.env.CLAUDE_CODE_TMPDIR, isolation.privateTemp);
    // playwright-cli drops its `.playwright-cli/` output directory into a writable cwd — with the sandbox off
    // that is the worktree, where it trips the verifier's source fingerprint and could even be committed.
    assert.equal(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR, join(isolation.privateTemp, "playwright-cli"));
    const chunks: string[] = [];
    const result = await isolation.bashOperations.exec("echo direct", root, { onData: (data) => chunks.push(String(data)), timeout: 30 });
    assert.equal(result.exitCode, 0);
    assert.equal(chunks.join("").trim(), "direct");
    await isolation.close();
    await assert.rejects(access(isolation.privateTemp));
    assert.equal(process.env.TMPDIR, previousTmpdir);
    assert.equal(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR, previousOutputDir);
    assert.deepEqual(spy.calls, []);
  } finally {
    spy.restore();
    await rm(root, { recursive: true, force: true });
  }
});

// The sandboxed path is unchanged by the refactor: initialize before any command, wrap every command, reset
// on close — and the temp directory still comes down afterwards.
test("openIsolation drives the sandbox runtime when config.sandbox is true", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-isolation-on-"));
  const spy = spySandboxManager();
  try {
    const isolation = await openIsolation(workerConfig(root, true), {
      worktree: root,
      processGroupFile: join(root, "active.pid"),
      visualVerification: false,
      dockerAccess: false,
      shutdownSignal: new AbortController().signal,
    });
    assert.equal(isolation.sandboxed, true);
    assert.deepEqual(spy.calls, ["initialize"]);
    // The spy's wrapper prefixes a fake bwrap invocation that bash cannot run; only the call sequence matters.
    await isolation.bashOperations.exec("true", root, { onData: () => undefined, timeout: 30 }).catch(() => undefined);
    assert.deepEqual(spy.calls, ["initialize", "wrap"]);
    await isolation.close();
    assert.deepEqual(spy.calls, ["initialize", "wrap", "reset"]);
    await assert.rejects(access(isolation.privateTemp));
  } finally {
    spy.restore();
    await rm(root, { recursive: true, force: true });
  }
});

// A verifier run must refuse Docker in both modes — without bwrap the daemon socket is reachable by
// construction, so this is the only thing that keeps independent verification off the Docker daemon.
test("openIsolation refuses Docker access for independent verifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-isolation-verify-"));
  try {
    await assert.rejects(
      openIsolation(workerConfig(root, false), {
        worktree: root,
        processGroupFile: join(root, "active.pid"),
        visualVerification: false,
        dockerAccess: true,
        verification: { readPaths: [], evidenceDir: join(root, "evidence") },
        shutdownSignal: new AbortController().signal,
      }),
      /Independent verifiers cannot access the Docker daemon/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
