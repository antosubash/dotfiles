import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { activeCommandProcessGroupPath, createBashOperations } from "../src/agent/process-group.js";

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

/** Fails the test if anything reaches the OS sandbox: direct mode must never wrap a command. */
function forbidSandboxWrapping(): () => void {
  const manager = SandboxManager as unknown as { wrapWithSandbox: (command: string) => Promise<string> };
  const previous = manager.wrapWithSandbox;
  manager.wrapWithSandbox = async () => { throw new Error("wrapWithSandbox must not be called in direct mode"); };
  return () => { manager.wrapWithSandbox = previous; };
}

// With sandboxing off, commands run through a plain `bash -c` — exit code and output flow through unchanged
// and the sandbox runtime is never consulted.
test("direct bash runs the command as-is and reports its exit code", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-direct-bash-"));
  const restore = forbidSandboxWrapping();
  try {
    const operations = createBashOperations(activeCommandProcessGroupPath(root), { sandbox: false });
    const chunks: string[] = [];
    const ok = await operations.exec("echo hello; pwd", root, { onData: (data) => chunks.push(String(data)), timeout: 30 });
    assert.equal(ok.exitCode, 0);
    assert.match(chunks.join(""), /hello\n/);
    assert.match(chunks.join(""), new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`));
    const failed = await operations.exec("exit 7", root, { onData: () => undefined, timeout: 30 });
    assert.equal(failed.exitCode, 7);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

// The secret scrub is the only thing standing between an unsandboxed agent and the worker's own credentials,
// so direct mode must apply it exactly like sandboxed mode does, while still passing explicit overrides.
test("direct bash scrubs credential-looking environment variables and applies overrides", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-direct-env-"));
  const restore = forbidSandboxWrapping();
  process.env.PIW_TEST_SECRET_TOKEN = "must-not-leak";
  process.env.PIW_TEST_PLAIN = "visible";
  try {
    const operations = createBashOperations(activeCommandProcessGroupPath(root), {
      sandbox: false,
      environmentOverrides: { PIW_TEST_OVERRIDE: "applied" },
    });
    const chunks: string[] = [];
    await operations.exec(
      "printf 'token=%s plain=%s override=%s\\n' \"${PIW_TEST_SECRET_TOKEN:-unset}\" \"$PIW_TEST_PLAIN\" \"$PIW_TEST_OVERRIDE\"",
      root,
      { onData: (data) => chunks.push(String(data)), timeout: 30 },
    );
    assert.equal(chunks.join("").trim(), "token=unset plain=visible override=applied");
  } finally {
    delete process.env.PIW_TEST_SECRET_TOKEN;
    delete process.env.PIW_TEST_PLAIN;
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

// Without bwrap there is no PID namespace to tear down, so the harness itself must be what ends a command's
// lifetime: a stray background service is killed and the call is rejected, exactly as in sandboxed mode.
test("direct bash kills leftover background processes and rejects the call", async (context) => {
  if (platform() === "win32") context.skip("POSIX process groups are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-direct-bg-"));
  const restore = forbidSandboxWrapping();
  try {
    const activeFile = activeCommandProcessGroupPath(root);
    const pidFile = join(root, "background.pid");
    const operations = createBashOperations(activeFile, { sandbox: false });
    const execution = operations.exec(
      `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`,
      root,
      { onData: () => undefined, timeout: 30 },
    );
    await waitForPath(pidFile);
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    if (!Number.isInteger(pid)) throw new Error("Background pid file did not contain a numeric pid");
    await assert.rejects(execution, /left background processes running/);
    await assert.rejects(access(activeFile));
    assert.throws(() => process.kill(pid, 0), (error: any) => error?.code === "ESRCH");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
