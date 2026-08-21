import assert from "node:assert/strict";
import test from "node:test";
import { commandBlockReason } from "../src/pi-agent.js";

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
