import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bridgeArguments, resolvePrivateRuntime } from "../src/docker-bridge.js";

test("Docker bridge accepts only a private worker runtime", async () => {
  const uid = process.getuid?.();
  assert.notEqual(uid, undefined);
  const runtime = await mkdtemp(join(`/run/user/${uid}`, "piw-bridge-test-"));
  try {
    await chmod(runtime, 0o700);
    assert.equal(resolvePrivateRuntime({ TMPDIR: runtime }, uid), runtime);
    assert.throws(
      () => resolvePrivateRuntime({ TMPDIR: "/tmp" }, uid),
      /directly beneath/,
    );
    await chmod(runtime, 0o755);
    assert.throws(
      () => resolvePrivateRuntime({ TMPDIR: runtime }, uid),
      /mode-0700/,
    );
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});

test("Docker bridge arguments reject host namespaces and shell syntax", () => {
  assert.deepEqual(bridgeArguments(["start", "issue-28_default", "geowiki-web", "8080"]), {
    action: "start",
    network: "issue-28_default",
    host: "geowiki-web",
    port: 8080,
  });
  assert.deepEqual(bridgeArguments(["stop"]), { action: "stop" });
  for (const args of [
    ["start", "host", "geowiki-web", "8080"],
    ["start", "issue-28_default", "host;id", "8080"],
    ["start", "issue-28_default", "geowiki-web", "0"],
    ["start", "issue-28_default", "geowiki-web", "8080", "extra"],
  ]) {
    assert.throws(() => bridgeArguments(args), /Docker bridge refused/);
  }
});
