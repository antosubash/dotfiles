import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  assertVisualSandboxIsolation,
  awaitAgentPromptCompletion,
  commandBlockReason,
  createAgentSettlementWatchdog,
  removeStaleSandboxTemps,
  sandboxConfig,
  sandboxEnvironment,
} from "../src/pi-agent.js";

test("settled agent events release a prompt that fails to settle", async () => {
  const never = new Promise<void>(() => undefined);
  assert.equal(
    await awaitAgentPromptCompletion(never, Promise.resolve(), 1_000, 5),
    "agent_settled",
  );
  assert.equal(
    await awaitAgentPromptCompletion(Promise.resolve(), never, 1_000, 5),
    "prompt",
  );
  await assert.rejects(
    () => awaitAgentPromptCompletion(never, never, 5, 5),
    /agent run exceeded 1 minutes/,
  );
  const stalled = createAgentSettlementWatchdog(5);
  stalled.arm();
  await assert.rejects(
    () => awaitAgentPromptCompletion(never, never, 1_000, 5, stalled.failure),
    /made no progress after its terminal agent_end/,
  );
  stalled.close();

  const settled = createAgentSettlementWatchdog(5);
  settled.arm();
  settled.settled();
  assert.equal(
    await awaitAgentPromptCompletion(never, Promise.resolve(), 1, 5, settled.failure),
    "agent_settled",
  );
  settled.close();
});

test("agent bash uses OS-level home denial and worktree-only writes", () => {
  const config = loadConfig({
    HOME: "/tmp/pi-home",
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
  });
  const sandbox = sandboxConfig("/tmp/pi-home/data/worktrees/issue-1", config);
  assert.deepEqual(sandbox.filesystem?.denyRead, [homedir()]);
  assert.deepEqual(sandbox.filesystem?.allowWrite, ["/tmp/pi-home/data/worktrees/issue-1", "/tmp"]);
  assert.ok(
    sandbox.filesystem?.allowRead?.some((path) => existsSync(join(path, "package.json"))),
    "the sandbox must be able to execute the packaged runtime helpers",
  );
  assert.ok(sandbox.network?.allowedDomains?.includes("registry.npmjs.org"));
});

test("visual sandbox exposes Unix sockets only behind private tmp and run-directory denials", () => {
  const config = loadConfig({
    HOME: "/tmp/pi-home",
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
  });
  const privateTemp = `/run/user/${process.getuid?.()}/piw-private`;
  const sandbox = sandboxConfig("/tmp/pi-home/data/worktrees/issue-1", config, {
    privateTemp,
    visualVerification: true,
  });
  assert.equal(sandbox.network?.allowAllUnixSockets, true);
  assert.ok(sandbox.filesystem?.denyRead?.includes("/tmp"));
  assert.equal(sandbox.filesystem?.denyRead?.includes("/run"), false);
  assert.ok(sandbox.filesystem?.denyRead?.includes("/var"));
  assert.ok(sandbox.filesystem?.allowRead?.includes(privateTemp));
  assert.ok(sandbox.filesystem?.allowWrite?.includes(privateTemp));
  assert.equal(sandbox.filesystem?.allowRead?.includes("/tmp"), false);
});

test("Docker socket access is explicit and scoped to the privileged run", () => {
  const config = loadConfig({
    HOME: "/tmp/pi-home",
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
  });
  const dockerSocket = "/run/docker.sock";
  const privateTemp = "/tmp/piw-private";
  const sandbox = sandboxConfig("/tmp/pi-home/data/worktrees/issue-1", config, {
    privateTemp,
    dockerSocket,
  });
  assert.equal(sandbox.network?.allowAllUnixSockets, true);
  assert.ok(sandbox.filesystem?.allowRead?.includes(dockerSocket));
  assert.ok(sandbox.filesystem?.allowWrite?.includes(dockerSocket));
  assert.ok(sandbox.filesystem?.denyRead?.includes("/tmp"));
  assert.ok(sandbox.filesystem?.denyRead?.includes("/var"));
  assert.ok(sandbox.filesystem?.allowWrite?.includes("/tmp/piw-private"));
  assert.equal(sandbox.filesystem?.allowWrite?.includes("/tmp"), false);

  const rootlessSocket = join(privateTemp, "..", "docker.sock");
  const rootless = sandboxConfig("/tmp/pi-home/data/worktrees/issue-1", config, {
    privateTemp,
    dockerSocket: rootlessSocket,
  });
  assert.equal(rootless.filesystem?.denyRead?.includes(rootlessSocket), false);
  assert.ok(rootless.filesystem?.allowRead?.includes(rootlessSocket));
});

test("visual sandbox isolation fails closed without namespace and socket-path hiding", () => {
  assert.doesNotThrow(() =>
    assertVisualSandboxIsolation("bwrap --unshare-net --tmpfs /tmp --tmpfs /var"),
  );
  assert.throws(
    () => assertVisualSandboxIsolation("bwrap --tmpfs /tmp --tmpfs /var"),
    /network namespace/,
  );
  assert.throws(
    () => assertVisualSandboxIsolation("bwrap --unshare-net --tmpfs /tmp"),
    /\/var/,
  );
});

test("non-visual runs retain ordinary /tmp compatibility and Unix-socket blocking", () => {
  const config = loadConfig({
    HOME: "/tmp/pi-home",
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
  });
  const sandbox = sandboxConfig("/tmp/pi-home/data/worktrees/issue-1", config, {
    privateTemp: "/tmp/piw-private",
  });
  assert.equal(sandbox.network?.allowAllUnixSockets, undefined);
  assert.equal(sandbox.filesystem?.denyRead?.includes("/tmp"), false);
  assert.ok(sandbox.filesystem?.allowWrite?.includes("/tmp"));
});

test("stale private sandbox temp directories are expired without touching active ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "piw-cleanup-test-"));
  const old = join(root, "piw-old");
  const active = join(root, "piw-active");
  try {
    await mkdir(old);
    await mkdir(active);
    await writeFile(join(active, ".owner-pid"), `${process.pid}\n`);
    const now = Date.now();
    const oldDate = new Date(now - 25 * 60 * 60 * 1_000);
    await utimes(old, oldDate, oldDate);
    await utimes(active, oldDate, oldDate);
    await removeStaleSandboxTemps(root, now);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(active), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandboxed bash does not inherit common credential environment variables", () => {
  const environment = sandboxEnvironment({ PATH: "/bin", HOME: "/home/test", GH_TOKEN: "secret", AWS_ACCESS_KEY_ID: "secret", SAFE_FLAG: "1" });
  assert.deepEqual(environment, { PATH: "/bin", HOME: "/home/test", SAFE_FLAG: "1" });
});

test("headless policy keeps GitHub and git writes in the controller", () => {
  assert.match(commandBlockReason("gh pr create", []) || "", /GitHub CLI/);
  assert.match(commandBlockReason("git push origin branch", []) || "", /git mutation/);
  assert.match(commandBlockReason("git -C /tmp/repo push origin branch", []) || "", /git mutation/);
  assert.match(commandBlockReason("git commit -m test", []) || "", /git mutation/);
  assert.equal(commandBlockReason("git diff --stat", []), null);
  assert.match(commandBlockReason("docker build .", []) || "", /explicit trusted/);
  assert.equal(commandBlockReason("docker build .", [], { dockerAccess: true }), null);
  assert.match(
    commandBlockReason("docker run --privileged image", [], { dockerAccess: true }) || "",
    /forbidden/,
  );
  for (const command of [
    "docker run -v /:/host image",
    "docker run -v/:/host image",
    "docker run --volume /:/host image",
    "docker run --volume=/:/host image",
    "docker run \\\n--volume /:/host image",
  ]) {
    assert.match(commandBlockReason(command, [], { dockerAccess: true }) || "", /forbidden/);
  }
});

test("headless policy blocks privilege, destructive commands, and configured paths", () => {
  assert.match(commandBlockReason("sudo apt install x", []) || "", /privilege/);
  assert.match(commandBlockReason("rm -rf build", []) || "", /deletion/);
  assert.match(commandBlockReason("rm --recursive build", []) || "", /deletion/);
  assert.match(
    commandBlockReason("node tools/repository-controller/script.js", ["tools/repository-controller"]) || "",
    /protected path/,
  );
  assert.equal(commandBlockReason("npm test", ["tools/repository-controller"]), null);
});
