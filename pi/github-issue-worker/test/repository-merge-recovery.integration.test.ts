import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { execFile } from "../src/exec.js";
import { RepositoryManager } from "../src/repository.js";

async function revision(path: string, ref = "HEAD"): Promise<string> {
  return (await execFile("git", ["rev-parse", ref], { cwd: path })).stdout.trim();
}

async function commit(path: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(path, file), content);
  await execFile("git", ["add", file], { cwd: path });
  await execFile("git", ["commit", "-m", message], { cwd: path });
  return revision(path);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-merge-recovery-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await execFile("git", ["init", "--initial-branch=main"], { cwd: source });
  await execFile("git", ["config", "user.name", "Test Worker"], { cwd: source });
  await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: source });
  const initial = await commit(source, "README.md", "initial\n", "initial");
  await execFile("git", ["clone", "--bare", source, remote]);
  await execFile("git", ["remote", "add", "origin", remote], { cwd: source });
  const manager = new RepositoryManager(loadConfig({
    HOME: root,
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_REPOSITORY_URL: remote,
    PI_WORKER_BASE_BRANCH: "main",
    PI_WORKER_DATA_DIR: join(root, "data"),
  }));
  await manager.ensureControlRepository();
  const worktree = await manager.ensureIssueWorktree(42, "Merge recovery");
  await execFile("git", ["config", "user.name", "Test Worker"], { cwd: worktree.path });
  await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: worktree.path });
  const featureHead = await commit(worktree.path, "feature.txt", "feature\n", "feature");
  await manager.pushIfAhead(worktree.path, worktree.branch);
  const baseOne = await commit(source, "base-one.txt", "one\n", "base one");
  await execFile("git", ["push", "origin", "main"], { cwd: source });
  await manager.fetchBase();
  await execFile("git", ["merge", "--no-ff", "origin/main", "-m", "merge base one"], { cwd: worktree.path });
  return { root, source, remote, manager, worktree, initial, featureHead, baseOne };
}

async function advanceBase(source: string): Promise<string> {
  const base = await commit(source, "base-two.txt", "two\n", "base two");
  await execFile("git", ["push", "origin", "main"], { cwd: source });
  return base;
}

test("recovery pushes a trusted B1 merge after B2 advances without claiming B2", async () => {
  const f = await fixture();
  try {
    const mergeHead = await revision(f.worktree.path);
    const baseTwo = await advanceBase(f.source);
    assert.equal(await f.manager.recoverBaseMergePush(f.worktree.path, f.worktree.branch, f.featureHead, baseTwo), false);
    const remoteHead = (await execFile("git", ["ls-remote", "--heads", "origin", `refs/heads/${f.worktree.branch}`], { cwd: f.worktree.path })).stdout.split(/\s+/)[0];
    assert.equal(remoteHead, mergeHead);
    const parents = (await execFile("git", ["rev-list", "--parents", "-n", "1", mergeHead], { cwd: f.worktree.path })).stdout.trim().split(/\s+/);
    assert.deepEqual(parents.slice(1), [f.featureHead, f.baseOne]);
    assert.equal((await execFile("git", ["merge-base", "--is-ancestor", baseTwo, mergeHead], { cwd: f.worktree.path, allowFailure: true })).exitCode, 1);
    assert.equal((await execFile("git", ["show", `${mergeHead}:feature.txt`], { cwd: f.worktree.path })).stdout, "feature\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a staged B1 merge is discarded when the fetched base advances to B2", async () => {
  const f = await fixture();
  try {
    await execFile("git", ["reset", "--hard", f.featureHead], { cwd: f.worktree.path });
    await execFile("git", ["merge", "--no-commit", "--no-ff", "origin/main"], { cwd: f.worktree.path });
    const baseTwo = await advanceBase(f.source);
    const stale = await f.manager.beginBaseMerge(f.worktree.path, f.worktree.branch, f.featureHead);
    assert.deepEqual(stale, { baseSha: baseTwo, conflicts: [], alreadyCurrent: false, mergeInProgress: false, staleMerge: true });
    assert.equal(await f.manager.hasMergeInProgress(f.worktree.path), false);
    assert.equal((await execFile("git", ["status", "--porcelain"], { cwd: f.worktree.path })).stdout, "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("recovery still rejects untrusted, nonancestor, and moved feature heads", async (t) => {
  await t.test("untrusted merge parent", async () => {
    const f = await fixture();
    try {
      const tree = await revision(f.worktree.path, "HEAD^{tree}");
      const untrusted = (await execFile("git", ["commit-tree", tree], { cwd: f.worktree.path, input: "untrusted\n" })).stdout.trim();
      const forged = (await execFile("git", ["commit-tree", tree, "-p", f.featureHead, "-p", untrusted], { cwd: f.worktree.path, input: "forged\n" })).stdout.trim();
      await execFile("git", ["reset", "--hard", forged], { cwd: f.worktree.path });
      await assert.rejects(f.manager.recoverBaseMergePush(f.worktree.path, f.worktree.branch, f.featureHead, f.baseOne), /not an ancestor/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  await t.test("base history no longer contains B1", async () => {
    const f = await fixture();
    try {
      await execFile("git", ["reset", "--hard", f.initial], { cwd: f.source });
      const divergentBase = await commit(f.source, "different.txt", "different\n", "different base");
      await execFile("git", ["push", "--force", "origin", "main"], { cwd: f.source });
      await assert.rejects(f.manager.recoverBaseMergePush(f.worktree.path, f.worktree.branch, f.featureHead, divergentBase), /non-fast-forward|not an ancestor/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  await t.test("feature head moved remotely", async () => {
    const f = await fixture();
    try {
      const other = join(f.root, "other");
      await execFile("git", ["clone", "--branch", f.worktree.branch, f.remote, other]);
      await execFile("git", ["config", "user.name", "Other"], { cwd: other });
      await execFile("git", ["config", "user.email", "other@example.invalid"], { cwd: other });
      const movedHead = await commit(other, "moved.txt", "moved\n", "moved feature");
      await execFile("git", ["push", "origin", f.worktree.branch], { cwd: other });
      await assert.rejects(f.manager.recoverBaseMergePush(f.worktree.path, f.worktree.branch, movedHead, f.baseOne), /not the expected controller-created/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
