import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const supervisorUnit = fileURLToPath(
  new URL("../systemd/pi-issue-worker-supervisor.service", import.meta.url),
);
const profileUnit = fileURLToPath(
  new URL("../systemd/pi-issue-worker@.service", import.meta.url),
);

test("systemd units permit Pi SDK auth locking without exposing it to agent bash", async () => {
  for (const path of [supervisorUnit, profileUnit]) {
    const unit = await readFile(path, "utf8");
    assert.match(unit, /^ProtectHome=read-only$/m);
    assert.match(unit, /^ReadWritePaths=.*%h\/\.pi\/agent.*%t$/m);
  }
});

test("systemd supervisor signals the complete worker control group", async () => {
  const unit = await readFile(supervisorUnit, "utf8");
  assert.match(unit, /^KillMode=control-group$/m);
});
