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

// With OS sandboxing off, agent bash runs directly under the unit's own hardening, and ProtectHome=read-only
// is then what breaks `dotnet restore` (~/.nuget), `aspire` (~/.aspire), dev-certs (~/.dotnet) and package
// stores. Those toolchain homes are opened for writing; the `-` prefix keeps a unit valid on a host that
// lacks one of them.
test("systemd units open the toolchain homes an unsandboxed agent must write", async () => {
  for (const path of [supervisorUnit, profileUnit]) {
    const unit = await readFile(path, "utf8");
    for (const home of [".nuget", ".aspire", ".dotnet", ".local/share/pnpm", ".npm"]) {
      assert.match(unit, new RegExp(`^ReadWritePaths=.*-%h/${home.replace(/[./]/g, "\\$&")}(?:\\s|$)`, "m"), `${path} opens ~/${home}`);
    }
  }
});

test("systemd supervisor signals the complete worker control group", async () => {
  const unit = await readFile(supervisorUnit, "utf8");
  assert.match(unit, /^KillMode=control-group$/m);
});
