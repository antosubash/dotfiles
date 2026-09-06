import { isProtectedChange, type RepositoryContext } from "./paths.js";
import { changedFiles, fetchBase, validateWorktree } from "./inspect.js";

export async function commitAndPush(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
  commitMessage: string,
): Promise<{ commit: string; files: string[] }> {
  await validateWorktree(ctx, worktree, branch);
  const files = await changedFiles(ctx, worktree);
  if (files.length === 0) throw new Error("Pi completed without changing any files");
  const protectedFiles = files.filter((path) => isProtectedChange(path, ctx.config.protectedPaths));
  if (protectedFiles.length > 0) {
    throw new Error(`Protected paths were changed: ${protectedFiles.join(", ")}`);
  }

  await ctx.run("git", ["add", "--all"], { cwd: worktree });
  const staged = await ctx.run("git", ["diff", "--cached", "--name-only", "-z"], {
    cwd: worktree,
  });
  const stagedFiles = staged.stdout.split("\0").filter(Boolean);
  const protectedStaged = stagedFiles.filter((path) =>
    isProtectedChange(path, ctx.config.protectedPaths),
  );
  if (protectedStaged.length > 0) {
    await ctx.run("git", ["reset"], { cwd: worktree });
    throw new Error(`Protected paths were staged: ${protectedStaged.join(", ")}`);
  }

  await ctx.run("git", ["commit", "-m", commitMessage], {
    cwd: worktree,
    timeoutMs: 5 * 60_000,
  });
  const commit = (
    await ctx.run("git", ["rev-parse", "HEAD"], { cwd: worktree })
  ).stdout.trim();
  await validateWorktree(ctx, worktree, branch);
  await ctx.run("git", ["push", "--set-upstream", "origin", branch], {
    cwd: worktree,
    timeoutMs: 10 * 60_000,
  });
  return { commit, files: stagedFiles };
}

export async function clearAgentChanges(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
): Promise<void> {
  await validateWorktree(ctx, worktree, branch);
  try {
    await ctx.run("git", ["reset", "--hard", "HEAD"], { cwd: worktree });
    await ctx.run("git", ["clean", "-fdx", "-e", ".qa"], { cwd: worktree });
  } catch (cleanupError) {
    try {
      await ctx.run("git", ["worktree", "remove", "--force", worktree], {
        cwd: ctx.controlPath,
      });
    } catch (removalError) {
      throw new Error(
        `Unable to clean or remove blocked agent worktree: ${String(cleanupError)}; ${String(removalError)}`,
      );
    }
  }
}

export async function hasCommitsAhead(ctx: RepositoryContext, worktree: string): Promise<boolean> {
  await fetchBase(ctx);
  const result = await ctx.run(
    "git",
    ["rev-list", "--count", `origin/${ctx.config.baseBranch}..HEAD`],
    { cwd: worktree },
  );
  return Number.parseInt(result.stdout.trim() || "0", 10) > 0;
}

export async function hasUnpushedCommits(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
): Promise<boolean> {
  const remoteBranch = await ctx.run(
    "git",
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: worktree, allowFailure: true, timeoutMs: 120_000 },
  );
  if (remoteBranch.exitCode !== 0) return hasCommitsAhead(ctx, worktree);
  await ctx.run(
    "git",
    ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: worktree, timeoutMs: 5 * 60_000 },
  );
  const result = await ctx.run(
    "git",
    ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
    { cwd: worktree },
  );
  const [behindText = "0", aheadText = "0"] = result.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindText, 10);
  const ahead = Number.parseInt(aheadText, 10);
  if (behind > 0) {
    throw new Error(
      `Remote branch origin/${branch} moved independently; automatic rebase or force-push is forbidden`,
    );
  }
  return ahead > 0;
}

export async function pushIfAhead(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
): Promise<void> {
  await validateWorktree(ctx, worktree, branch);
  await ctx.run("git", ["push", "origin", branch], {
    cwd: worktree,
    timeoutMs: 10 * 60_000,
  });
}
