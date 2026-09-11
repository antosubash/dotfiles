import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { execFile } from "../src/exec.js";
import { RepositoryManager } from "../src/repository.js";

const git = (cwd: string, args: string[]) => execFile("git", args, { cwd });
const revParse = async (cwd: string, ref = "HEAD") => (await git(cwd, ["rev-parse", ref])).stdout.trim();

async function commitFile(cwd: string, name: string, message: string): Promise<string> {
  await writeFile(join(cwd, name), `${message}\n`);
  await git(cwd, ["add", name]);
  await git(cwd, ["commit", "-m", message]);
  return revParse(cwd);
}

/** A source repo with a pushed feature branch, a bare origin, and a control clone holding the PR worktree. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-cleanup-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.name", "Test Worker"]);
  await git(source, ["config", "user.email", "worker@example.invalid"]);
  await commitFile(source, "README.md", "init");
  await git(source, ["checkout", "-b", "feature/adopt-me"]);
  const featureHead = await commitFile(source, "feature.txt", "feature");
  await execFile("git", ["clone", "--bare", source, remote]);
  const manager = new RepositoryManager(loadConfig({
    HOME: root, PI_WORKER_REPOSITORY: "example/widgets", PI_WORKER_REPOSITORY_URL: remote,
    PI_WORKER_BASE_BRANCH: "main", PI_WORKER_DATA_DIR: join(root, "data"),
  }));
  await manager.ensureControlRepository();
  const worktree = await manager.ensurePullRequestWorktree(88, "feature/adopt-me", featureHead);
  return { root, source, remote, manager, worktree, featureHead, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// Shape taken from antosubash/simple_module_python#279: GitHub "Update branch" added a merge commit on the
// remote, the PR was squash-merged, and the local worktree stayed one commit behind the merged head forever.
test("a merged worktree whose HEAD is an ancestor of the merged PR head is removed", async () => {
  const f = await fixture();
  try {
    const mergedHead = await commitFile(f.source, "update.txt", "Merge branch 'main' into feature/adopt-me");
    await git(f.source, ["push", f.remote, "feature/adopt-me"]);
    await git(f.remote, ["update-ref", "refs/pull/88/head", mergedHead]);
    await git(f.remote, ["update-ref", "-d", "refs/heads/feature/adopt-me"]);
    assert.equal(await f.manager.headRevision(f.worktree.path), f.featureHead);

    await f.manager.removeManagedWorktree("pull_request", 88, f.worktree.path, f.worktree.branch, mergedHead, 88);
    await assert.rejects(access(f.worktree.path));
  } finally { await f.cleanup(); }
});

test("a merged worktree holding a commit the merged PR head does not contain is preserved", async () => {
  const f = await fixture();
  try {
    await git(f.remote, ["update-ref", "refs/pull/88/head", f.featureHead]);
    await git(f.worktree.path, ["config", "user.name", "Test Worker"]);
    await git(f.worktree.path, ["config", "user.email", "worker@example.invalid"]);
    const unmerged = await commitFile(f.worktree.path, "local-only.txt", "never pushed");

    await assert.rejects(
      f.manager.removeManagedWorktree("pull_request", 88, f.worktree.path, f.worktree.branch, f.featureHead, 88),
      (error: Error) => error.message.includes(unmerged) && /not contained|not reachable|unmerged/i.test(error.message),
    );
    await access(f.worktree.path);
  } finally { await f.cleanup(); }
});
