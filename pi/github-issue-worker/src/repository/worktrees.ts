import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { JobKind } from "../types.js";
import {
  branchForIssue,
  pathForIssue,
  pathForPullRequest,
  type RepositoryContext,
} from "./paths.js";
import {
  changedFiles,
  fetchBase,
  hasMergeInProgress,
  headRevision,
  isRegistered,
  validateWorktree,
} from "./inspect.js";

export async function ensureIssueWorktree(
  ctx: RepositoryContext,
  issueNumber: number,
  branchOrTitle: string,
  claimedPath?: string,
): Promise<{ branch: string; path: string }> {
  await fetchBase(ctx);
  await mkdir(ctx.worktreesRoot, { recursive: true });
  const branch = claimedPath ? branchOrTitle : branchForIssue(issueNumber, branchOrTitle);
  const path = claimedPath || pathForIssue(ctx.worktreesRoot, issueNumber);
  const expectedPath = resolve(path);
  const registered = await isRegistered(ctx, expectedPath);
  if (registered) {
    await validateWorktree(ctx, expectedPath, branch);
    return { branch, path: expectedPath };
  }
  if (expectedPath !== resolve(pathForIssue(ctx.worktreesRoot, issueNumber))) {
    throw new Error(`Refusing unregistered worktree path outside issue allocation: ${path}`);
  }
  const worktreePath = expectedPath;

  const pathExists = await access(worktreePath)
    .then(() => true)
    .catch(() => false);
  if (pathExists) {
    throw new Error(`Refusing unregistered pre-existing worktree path: ${worktreePath}`);
  }

  const localBranch = await ctx.run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: ctx.controlPath, allowFailure: true },
  );
  if (localBranch.exitCode === 0) {
    await ctx.run("git", ["worktree", "add", worktreePath, branch], { cwd: ctx.controlPath });
  } else {
    const remoteBranch = await ctx.run(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      { cwd: ctx.controlPath, allowFailure: true, timeoutMs: 120_000 },
    );
    const startPoint = remoteBranch.exitCode === 0 ? `origin/${branch}` : `origin/${ctx.config.baseBranch}`;
    if (remoteBranch.exitCode === 0) {
      await ctx.run(
        "git",
        ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
        { cwd: ctx.controlPath, timeoutMs: 5 * 60_000 },
      );
    }
    await ctx.run(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, startPoint],
      { cwd: ctx.controlPath, timeoutMs: 5 * 60_000 },
    );
  }
  await validateWorktree(ctx, worktreePath, branch);
  return { branch, path: worktreePath };
}

export async function ensurePullRequestWorktree(
  ctx: RepositoryContext,
  prNumber: number,
  branch: string,
  expectedHead: string,
  claimedPath?: string,
): Promise<{ branch: string; path: string }> {
  await fetchBase(ctx);
  await mkdir(ctx.worktreesRoot, { recursive: true });
  const path = claimedPath || pathForPullRequest(ctx.worktreesRoot, prNumber);
  const expectedPath = resolve(path);
  if (expectedPath !== resolve(pathForPullRequest(ctx.worktreesRoot, prNumber))) {
    throw new Error(`Refusing worktree path outside pull request allocation: ${path}`);
  }
  await ctx.run("git", ["check-ref-format", "--branch", branch], { cwd: ctx.controlPath });
  const previousRemote = await ctx.run(
    "git",
    ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
    { cwd: ctx.controlPath, allowFailure: true },
  );
  const previousRemoteHead = previousRemote.exitCode === 0 ? previousRemote.stdout.trim() : null;
  const registered = await isRegistered(ctx, expectedPath);
  let localHead: string | null = null;
  if (registered) {
    await validateWorktree(ctx, expectedPath, branch);
    localHead = await headRevision(ctx, expectedPath);
  }
  await ctx.run(
    "git",
    ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: ctx.controlPath, timeoutMs: 5 * 60_000 },
  );
  const remoteHead = (
    await ctx.run("git", ["rev-parse", `refs/remotes/origin/${branch}`], {
      cwd: ctx.controlPath,
    })
  ).stdout.trim();
  if (remoteHead !== expectedHead) {
    throw new Error(
      `Pull request #${prNumber} head changed during adoption (${expectedHead} != ${remoteHead})`,
    );
  }
  if (registered) {
    if (localHead !== remoteHead) {
      const changed = await changedFiles(ctx, expectedPath);
      const mergeInProgress = await hasMergeInProgress(ctx, expectedPath);
      if (localHead !== previousRemoteHead || changed.length > 0 || mergeInProgress) {
        throw new Error(
          `Refusing stale pull request worktree update (${localHead} != ${remoteHead}); local work may be present`,
        );
      }
      await ctx.run("git", ["reset", "--hard", remoteHead], { cwd: expectedPath });
    }
    await validateWorktree(ctx, expectedPath, branch);
    return { branch, path: expectedPath };
  }
  const pathExists = await access(expectedPath)
    .then(() => true)
    .catch(() => false);
  if (pathExists) {
    throw new Error(`Refusing unregistered pre-existing worktree path: ${expectedPath}`);
  }
  const localBranch = await ctx.run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: ctx.controlPath, allowFailure: true },
  );
  if (localBranch.exitCode === 0) {
    const branchHead = (
      await ctx.run("git", ["rev-parse", `refs/heads/${branch}`], { cwd: ctx.controlPath })
    ).stdout.trim();
    if (branchHead !== remoteHead) {
      if (branchHead !== previousRemoteHead) {
        throw new Error(
          `Refusing pull request #${prNumber}: local branch ${branch} contains untracked controller history`,
        );
      }
      await ctx.run("git", ["branch", "--force", branch, remoteHead], {
        cwd: ctx.controlPath,
      });
    }
    await ctx.run("git", ["worktree", "add", expectedPath, branch], {
      cwd: ctx.controlPath,
      timeoutMs: 5 * 60_000,
    });
  } else {
    await ctx.run(
      "git",
      ["worktree", "add", "-b", branch, expectedPath, `refs/remotes/origin/${branch}`],
      { cwd: ctx.controlPath, timeoutMs: 5 * 60_000 },
    );
  }
  await validateWorktree(ctx, expectedPath, branch);
  return { branch, path: expectedPath };
}

/**
 * GitHub keeps `refs/pull/<n>/head` at the PR's final head even after a squash merge deletes the branch,
 * so it is the one ref that reliably carries the merged commit. A worktree is safe to remove when it holds
 * no commit the merged head does not contain — equality is not required, because a remote "Update branch"
 * merge leaves the local branch permanently one commit behind.
 */
async function assertContainedInMergedHead(
  ctx: RepositoryContext,
  head: string,
  mergedHead: string,
  prNumber: number,
): Promise<void> {
  const present = await ctx.run("git", ["cat-file", "-e", `${mergedHead}^{commit}`], {
    cwd: ctx.controlPath,
    allowFailure: true,
  });
  if (present.exitCode !== 0) {
    await ctx.run("git", ["fetch", "--quiet", "origin", `refs/pull/${prNumber}/head`], {
      cwd: ctx.controlPath,
      timeoutMs: 120_000,
    });
  }
  const contained = await ctx.run("git", ["merge-base", "--is-ancestor", head, mergedHead], {
    cwd: ctx.controlPath,
    allowFailure: true,
  });
  if (contained.exitCode !== 0) {
    throw new Error(
      `Refusing cleanup because worktree HEAD ${head} is not contained in merged PR head ${mergedHead}`,
    );
  }
}

export async function removeManagedWorktree(
  ctx: RepositoryContext,
  kind: JobKind,
  number: number,
  worktree: string,
  branch: string,
  expectedHead: string,
  prNumber: number,
): Promise<void> {
  const expectedPath = resolve(
    kind === "pull_request" ? pathForPullRequest(ctx.worktreesRoot, number) : pathForIssue(ctx.worktreesRoot, number),
  );
  if (resolve(worktree) !== expectedPath) {
    throw new Error(`Refusing cleanup outside managed ${kind} allocation: ${worktree}`);
  }
  if (!(await isRegistered(ctx, expectedPath))) {
    const exists = await access(expectedPath)
      .then(() => true)
      .catch(() => false);
    if (exists) throw new Error(`Refusing unregistered cleanup path: ${expectedPath}`);
    return;
  }
  await validateWorktree(ctx, expectedPath, branch);
  if (await hasMergeInProgress(ctx, expectedPath)) {
    throw new Error(`Refusing cleanup with a merge in progress: ${expectedPath}`);
  }
  const changed = await changedFiles(ctx, expectedPath);
  if (changed.length > 0) {
    throw new Error(`Refusing cleanup with tracked or untracked changes: ${changed.join(", ")}`);
  }
  const head = await headRevision(ctx, expectedPath);
  if (head !== expectedHead) await assertContainedInMergedHead(ctx, head, expectedHead, prNumber);
  await ctx.run("git", ["worktree", "remove", expectedPath], {
    cwd: ctx.controlPath,
    timeoutMs: 5 * 60_000,
  });
  await ctx.run("git", ["worktree", "prune"], { cwd: ctx.controlPath });
  const remains = await access(expectedPath)
    .then(() => true)
    .catch(() => false);
  if (remains) throw new Error(`Worktree cleanup did not remove ${expectedPath}`);
}
