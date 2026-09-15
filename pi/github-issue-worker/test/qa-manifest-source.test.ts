import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWorkerQaManifest, privateQaManifestPath } from "../src/qa-manifest-source.js";

const privateManifest = { version: 1, launch: { argv: ["./scripts/start.sh"] }, readiness: { endpoints: { frontend: "http://localhost:3001" } } };
const repoManifest = { version: 1, commands: { check: { argv: ["pnpm", "check"] } } };

async function fixture(): Promise<{ root: string; worktree: string; config: { dataDir: string; qaManifestPath: string } }> {
  const root = await mkdtemp(join(tmpdir(), "pi-manifest-source-"));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".pi-worker"), { recursive: true });
  await mkdir(join(root, "data", "memory"), { recursive: true });
  return { root, worktree, config: { dataDir: join(root, "data"), qaManifestPath: ".pi-worker/qa.json" } };
}

test("the private manifest in the profile's memory directory wins over the repository's", async () => {
  const { root, worktree, config } = await fixture();
  try {
    assert.equal(privateQaManifestPath(config), join(root, "data", "memory", "qa.json"));
    await writeFile(join(worktree, ".pi-worker", "qa.json"), JSON.stringify(repoManifest));
    assert.deepEqual(await loadWorkerQaManifest(config, worktree), repoManifest);
    await writeFile(privateQaManifestPath(config), JSON.stringify(privateManifest), { mode: 0o600 });
    assert.deepEqual(await loadWorkerQaManifest(config, worktree), privateManifest);
    await rm(join(worktree, ".pi-worker", "qa.json"));
    assert.deepEqual(await loadWorkerQaManifest(config, worktree), privateManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no manifest anywhere is null; a broken, symlinked or loose-permission private one fails closed", async () => {
  const { root, worktree, config } = await fixture();
  try {
    assert.equal(await loadWorkerQaManifest(config, worktree), null);
    await writeFile(privateQaManifestPath(config), "{ not json", { mode: 0o600 });
    await assert.rejects(loadWorkerQaManifest(config, worktree), /private QA manifest is not valid JSON/);
    await writeFile(privateQaManifestPath(config), JSON.stringify({ version: 1, surprise: true }), { mode: 0o600 });
    await assert.rejects(loadWorkerQaManifest(config, worktree), /QA manifest/);
    await writeFile(privateQaManifestPath(config), JSON.stringify(privateManifest), { mode: 0o600 });
    await chmod(privateQaManifestPath(config), 0o664);
    await assert.rejects(loadWorkerQaManifest(config, worktree), /group\/world writable/);
    await rm(privateQaManifestPath(config));
    await writeFile(join(root, "elsewhere.json"), JSON.stringify(privateManifest), { mode: 0o600 });
    await symlink(join(root, "elsewhere.json"), privateQaManifestPath(config));
    await assert.rejects(loadWorkerQaManifest(config, worktree), /regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
