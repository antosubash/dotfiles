import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { commandBlockReason, sandboxConfig, sandboxEnvironment } from "../src/pi-agent.js";

test("agent bash uses OS-level home denial and worktree-only writes", () => {
  const config = loadConfig({
    HOME: "/tmp/pi-home",
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
  });
  const sandbox = sandboxConfig("/tmp/pi-home/data/worktrees/issue-1", config);
  assert.deepEqual(sandbox.filesystem?.denyRead, [homedir()]);
  assert.deepEqual(sandbox.filesystem?.allowWrite, ["/tmp/pi-home/data/worktrees/issue-1", "/tmp"]);
  assert.ok(sandbox.network?.allowedDomains?.includes("registry.npmjs.org"));
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
