import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { execFile } from "../src/exec.js";
import { RepositoryManager } from "../src/repository.js";

test("repository manager creates an isolated base worktree and always ignores .qa", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-repository-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const data = join(root, "data");
  try {
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main"], { cwd: source });
    await execFile("git", ["config", "user.name", "Test Worker"], { cwd: source });
    await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: source });
    await writeFile(join(source, "README.md"), "fixture\n");
    await execFile("git", ["add", "README.md"], { cwd: source });
    await execFile("git", ["commit", "-m", "init"], { cwd: source });
    await execFile("git", ["clone", "--bare", source, remote]);

    const config = loadConfig({
      HOME: root,
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_REPOSITORY_URL: remote,
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_DATA_DIR: data,
    });
    const manager = new RepositoryManager(config);
    await manager.ensureControlRepository();
    const worktree = await manager.ensureIssueWorktree(42, "Reusable worker");
    assert.equal(worktree.branch, "pi/issue-42-reusable-worker");

    const qa = join(worktree.path, ".qa", "issues", "42");
    await mkdir(qa, { recursive: true });
    await writeFile(join(qa, "proof.png"), "not really a png");
    const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree.path });
    assert.equal(status.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
