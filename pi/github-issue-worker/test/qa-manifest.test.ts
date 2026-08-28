import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadQaManifest } from "../src/qa-manifest.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-manifest-"));
  await mkdir(join(root, ".pi-worker"));
  return root;
}

test("QA manifest loads strict Aspire, preview, and argv command metadata", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify({
      version: 1,
      aspire: {
        apphost: "AppHost/AppHost.csproj",
        resources: { frontend: "example-frontend", api: "example-api" },
      },
      previews: {
        stats: { path: "/pagebuilder-styleshots?fixture=stats", category: "component" },
      },
      commands: { frontend: { argv: ["pnpm", "--filter", "app", "test"] } },
    }));
    assert.deepEqual(await loadQaManifest(root, ".pi-worker/qa.json"), {
      version: 1,
      aspire: {
        apphost: "AppHost/AppHost.csproj",
        resources: { frontend: "example-frontend", api: "example-api" },
      },
      previews: {
        stats: { path: "/pagebuilder-styleshots?fixture=stats", category: "component" },
      },
      commands: { frontend: { argv: ["pnpm", "--filter", "app", "test"] } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA manifest is optional but rejects symlinks and unsafe schemas", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "pi-worker-manifest-outside-"));
  try {
    assert.equal(await loadQaManifest(root, ".pi-worker/missing.json"), null);
    await writeFile(join(outside, "qa.json"), '{"version":1}');
    await symlink(join(outside, "qa.json"), join(root, ".pi-worker/qa.json"));
    await assert.rejects(loadQaManifest(root, ".pi-worker/qa.json"), /regular file|symlink/);
    await rm(join(root, ".pi-worker/qa.json"));

    for (const [value, pattern] of [
      [{ version: 1, unexpected: true }, /unknown key/],
      [{ version: 1, aspire: { apphost: "../outside.csproj" } }, /escapes the repository/],
      [{ version: 1, previews: { x: { path: "https://evil.test", category: "component" } } }, /unsafe/],
      [{ version: 1, commands: { test: { argv: "pnpm test" } } }, /argv is invalid/],
    ] as const) {
      await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify(value));
      await assert.rejects(loadQaManifest(root, ".pi-worker/qa.json"), pattern);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
