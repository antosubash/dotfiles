import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    await execFile("git", ["remote", "set-url", "origin", join(root, "wrong.git")], {
      cwd: manager.controlPath,
    });
    await assert.rejects(manager.ensureControlRepository(), /origin mismatch/);
    await execFile("git", ["remote", "set-url", "origin", remote], { cwd: manager.controlPath });
    const worktree = await manager.ensureIssueWorktree(42, "Reusable worker");
    assert.equal(worktree.branch, "pi/issue-42-reusable-worker");
    await assert.rejects(
      manager.ensureIssueWorktree(42, "pi/issue-42-renamed-title", worktree.path),
      /branch mismatch/,
    );

    const qa = join(worktree.path, ".qa", "issues", "42");
    await mkdir(qa, { recursive: true });
    await writeFile(join(qa, "proof.png"), "not really a png");
    const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree.path });
    assert.equal(status.stdout, "");

    await execFile("git", ["config", "user.name", "Test Worker"], { cwd: worktree.path });
    await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: worktree.path });
    await writeFile(join(worktree.path, "change.txt"), "repair\n");
    await execFile("git", ["add", "change.txt"], { cwd: worktree.path });
    await execFile("git", ["commit", "-m", "repair"], { cwd: worktree.path });
    assert.equal(await manager.hasUnpushedCommits(worktree.path, worktree.branch), true);
    await manager.pushIfAhead(worktree.path, worktree.branch);
    assert.equal(await manager.hasUnpushedCommits(worktree.path, worktree.branch), false);

    const other = join(root, "other");
    await execFile("git", ["clone", "--branch", worktree.branch, remote, other]);
    await execFile("git", ["config", "user.name", "Other Maintainer"], { cwd: other });
    await execFile("git", ["config", "user.email", "other@example.invalid"], { cwd: other });
    await writeFile(join(other, "remote-change.txt"), "remote\n");
    await execFile("git", ["add", "remote-change.txt"], { cwd: other });
    await execFile("git", ["commit", "-m", "remote change"], { cwd: other });
    await execFile("git", ["push", "origin", worktree.branch], { cwd: other });
    await assert.rejects(
      manager.hasUnpushedCommits(worktree.path, worktree.branch),
      /automatic rebase or force-push is forbidden/,
    );

    await writeFile(join(worktree.path, "README.md"), "unsafe partial edit\n");
    await writeFile(join(worktree.path, "partial-new-file.txt"), "unsafe partial edit\n");
    await manager.clearAgentChanges(worktree.path, worktree.branch);
    assert.equal((await execFile("git", ["status", "--porcelain"], { cwd: worktree.path })).stdout, "");
    await assert.rejects(access(join(worktree.path, "partial-new-file.txt")));
    await access(join(qa, "proof.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository manager adopts and safely removes a pull request worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-pr-repository-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  try {
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main"], { cwd: source });
    await execFile("git", ["config", "user.name", "Test Worker"], { cwd: source });
    await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: source });
    await writeFile(join(source, "README.md"), "base\n");
    await execFile("git", ["add", "README.md"], { cwd: source });
    await execFile("git", ["commit", "-m", "base"], { cwd: source });
    await execFile("git", ["clone", "--bare", source, remote]);
    await execFile("git", ["remote", "add", "origin", remote], { cwd: source });
    await execFile("git", ["switch", "-c", "feature/adopt-me"], { cwd: source });
    await writeFile(join(source, "feature.txt"), "feature\n");
    await execFile("git", ["add", "feature.txt"], { cwd: source });
    await execFile("git", ["commit", "-m", "feature"], { cwd: source });
    await execFile("git", ["push", "origin", "feature/adopt-me"], { cwd: source });
    const featureHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();

    const manager = new RepositoryManager(
      loadConfig({
        HOME: root,
        PI_WORKER_REPOSITORY: "example/widgets",
        PI_WORKER_REPOSITORY_URL: remote,
        PI_WORKER_BASE_BRANCH: "main",
        PI_WORKER_DATA_DIR: join(root, "data"),
      }),
    );
    await manager.ensureControlRepository();
    const worktree = await manager.ensurePullRequestWorktree(
      88,
      "feature/adopt-me",
      featureHead,
    );
    assert.equal(worktree.path, manager.pathForPullRequest(88));
    assert.equal(await manager.headRevision(worktree.path), featureHead);

    await writeFile(join(source, "second.txt"), "second\n");
    await execFile("git", ["add", "second.txt"], { cwd: source });
    await execFile("git", ["commit", "-m", "second feature head"], { cwd: source });
    await execFile("git", ["push", "origin", "feature/adopt-me"], { cwd: source });
    const secondHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    await manager.ensurePullRequestWorktree(88, "feature/adopt-me", secondHead, worktree.path);
    assert.equal(await manager.headRevision(worktree.path), secondHead);

    await execFile("git", ["reset", "--hard", featureHead], { cwd: source });
    await execFile("git", ["push", "--force", "origin", "feature/adopt-me"], { cwd: source });
    await manager.ensurePullRequestWorktree(88, "feature/adopt-me", featureHead, worktree.path);
    assert.equal(await manager.headRevision(worktree.path), featureHead);

    await writeFile(join(worktree.path, "README.md"), "dirty\n");
    await assert.rejects(
      manager.removeManagedWorktree("pull_request", 88, worktree.path, worktree.branch, featureHead),
      /changes/,
    );
    await execFile("git", ["reset", "--hard", "HEAD"], { cwd: worktree.path });
    await mkdir(join(worktree.path, ".qa"));
    await writeFile(join(worktree.path, ".qa", "evidence.png"), "ignored\n");
    await manager.removeManagedWorktree(
      "pull_request",
      88,
      worktree.path,
      worktree.branch,
      featureHead,
    );
    await assert.rejects(access(worktree.path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository manager merges a fresh base and commits an agent-resolved conflict without rebasing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-base-merge-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  try {
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main"], { cwd: source });
    await execFile("git", ["config", "user.name", "Test Worker"], { cwd: source });
    await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: source });
    await writeFile(join(source, "shared.txt"), "initial\n");
    await execFile("git", ["add", "shared.txt"], { cwd: source });
    await execFile("git", ["commit", "-m", "init"], { cwd: source });
    await execFile("git", ["clone", "--bare", source, remote]);
    await execFile("git", ["remote", "add", "origin", remote], { cwd: source });

    const manager = new RepositoryManager(
      loadConfig({
        HOME: root,
        PI_WORKER_REPOSITORY: "example/widgets",
        PI_WORKER_REPOSITORY_URL: remote,
        PI_WORKER_BASE_BRANCH: "main",
        PI_WORKER_DATA_DIR: join(root, "data"),
      }),
    );
    await manager.ensureControlRepository();
    const worktree = await manager.ensureIssueWorktree(42, "Conflict fixture");
    await execFile("git", ["config", "user.name", "Test Worker"], { cwd: worktree.path });
    await execFile("git", ["config", "user.email", "worker@example.invalid"], { cwd: worktree.path });
    await writeFile(join(worktree.path, "shared.txt"), "feature\n");
    await execFile("git", ["add", "shared.txt"], { cwd: worktree.path });
    await execFile("git", ["commit", "-m", "feature"], { cwd: worktree.path });
    await manager.pushIfAhead(worktree.path, worktree.branch);

    await writeFile(join(source, "shared.txt"), "base\n");
    await execFile("git", ["add", "shared.txt"], { cwd: source });
    await execFile("git", ["commit", "-m", "base update"], { cwd: source });
    await execFile("git", ["push", "origin", "main"], { cwd: source });

    const featureHead = await manager.headRevision(worktree.path);
    const merge = await manager.beginBaseMerge(worktree.path, worktree.branch, featureHead);
    assert.deepEqual(merge.conflicts, ["shared.txt"]);
    await writeFile(join(worktree.path, "shared.txt"), "base and feature\n");
    await execFile("git", ["add", "shared.txt"], { cwd: worktree.path });
    const resumed = await manager.beginBaseMerge(worktree.path, worktree.branch, featureHead);
    assert.equal(resumed.mergeInProgress, true);
    assert.deepEqual(resumed.conflicts, []);
    await manager.finishBaseMerge(worktree.path, worktree.branch, 42, featureHead);

    assert.equal((await manager.unmergedFiles(worktree.path)).length, 0);
    const parents = (
      await execFile("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: worktree.path })
    ).stdout.trim().split(/\s+/);
    assert.equal(parents.length, 3);
    assert.equal(await manager.hasUnpushedCommits(worktree.path, worktree.branch), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
