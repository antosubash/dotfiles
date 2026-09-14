import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppInstance } from "../src/app-instance/index.js";
import { withAppInstance } from "../src/worker/app-stage.js";
import { config } from "./helpers/worker-fixtures.js";

function fakeInstance(log: string[]): AppInstance {
  return {
    dir: "/i", runId: "r", fingerprint: "f", endpoints: { frontend: "http://localhost:3005" }, storageState: null, readinessMs: 1,
    environment: () => ({}),
    ensureCurrent: async () => { log.push("ensure"); return false; },
    stop: async () => { log.push("stop"); },
  };
}

async function worktreeWithLaunch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-stage-"));
  await mkdir(join(root, "w", ".pi-worker"), { recursive: true });
  await writeFile(
    join(root, "w", ".pi-worker", "qa.json"),
    JSON.stringify({ version: 1, launch: { argv: ["./run.sh"] }, readiness: { endpoints: { frontend: "http://localhost:3005" } } }),
  );
  return root;
}

test("withAppInstance starts once, hands the instance to the stages and stops in finally", async () => {
  const root = await worktreeWithLaunch();
  const log: string[] = [];
  const ctx = { config: config(root), appInstances: { start: async () => { log.push("start"); return fakeInstance(log); } } };
  try {
    const result = await withAppInstance(ctx as never, join(root, "w"), { issueNumber: 1 }, true, async (instance) => {
      log.push(`stage:${instance?.endpoints.frontend}`);
      return 7;
    });
    assert.equal(result, 7);
    assert.deepEqual(log, ["start", "stage:http://localhost:3005", "stop"]);
    await assert.rejects(
      withAppInstance(ctx as never, join(root, "w"), { issueNumber: 1 }, true, async () => { throw new Error("stage failed"); }),
      /stage failed/,
    );
    assert.equal(log.filter((entry) => entry === "stop").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no manifest launch or no need means no instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stage-"));
  await mkdir(join(root, "w"));
  const withLaunch = await worktreeWithLaunch();
  let starts = 0;
  const appInstances = { start: async () => { starts += 1; throw new Error("unexpected"); } };
  try {
    assert.equal(await withAppInstance({ config: config(root), appInstances } as never, join(root, "w"), { issueNumber: 1 }, true, async (instance) => instance), null);
    assert.equal(await withAppInstance({ config: config(withLaunch), appInstances } as never, join(withLaunch, "w"), { issueNumber: 1 }, false, async (instance) => instance), null);
    assert.equal(starts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(withLaunch, { recursive: true, force: true });
  }
});
