import { resolve } from "node:path";
import { BranchDivergenceError, type RepositoryContext } from "./paths.js";

export async function fetchBase(ctx: RepositoryContext): Promise<void> {
  await ctx.run(
    "git",
    [
      "fetch",
      "--prune",
      "origin",
      `refs/heads/${ctx.config.baseBranch}:refs/remotes/origin/${ctx.config.baseBranch}`,
    ],
    { cwd: ctx.controlPath, timeoutMs: 5 * 60_000 },
  );
}

export async function validateWorktree(
  ctx: RepositoryContext,
  path: string,
  branch: string,
): Promise<void> {
  const symbolicBranch = (
    await ctx.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path })
  ).stdout.trim();
  if (symbolicBranch !== branch) {
    throw new Error(`Worktree branch mismatch at ${path}: expected ${branch}, found ${symbolicBranch || "detached HEAD"}`);
  }
  const head = (await ctx.run("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
  const entry = await worktreeEntry(ctx, path);
  if (!entry || entry.head !== head || entry.branch !== `refs/heads/${branch}`) {
    throw new Error(`Registered worktree identity mismatch at ${path}`);
  }
}

export async function worktreeEntry(
  ctx: RepositoryContext,
  path: string,
): Promise<{ head: string; branch: string } | null> {
  const result = await ctx.run("git", ["worktree", "list", "--porcelain"], {
    cwd: ctx.controlPath,
  });
  const lines = result.stdout.split(/\r?\n/);
  const expected = resolve(path);
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] || "") !== `worktree ${expected}`) continue;
    const headLine = lines[index + 1] || "";
    const head = headLine.startsWith("HEAD ") ? headLine.slice(5).trim() : "";
    const branchLine = lines
      .slice(index + 2)
      .find((line) => line === "" || line.startsWith("worktree ") || line.startsWith("branch "));
    return {
      head,
      branch: branchLine?.startsWith("branch ")
        ? branchLine.slice("branch ".length).trim()
        : "",
    };
  }
  return null;
}

export async function isRegistered(ctx: RepositoryContext, path: string): Promise<boolean> {
  const result = await ctx.run("git", ["worktree", "list", "--porcelain"], {
    cwd: ctx.controlPath,
  });
  const expected = resolve(path);
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => resolve(line.slice("worktree ".length)) === expected);
}

export async function headRevision(ctx: RepositoryContext, worktree: string): Promise<string> {
  return (await ctx.run("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
}

export async function filesChangedBetween(
  ctx: RepositoryContext,
  worktree: string,
  fromRevision: string,
  toRevision?: string,
): Promise<string[]> {
  const result = await ctx.run(
    "git",
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      fromRevision,
      ...(toRevision ? [toRevision] : []),
    ],
    { cwd: worktree },
  );
  return result.stdout.split("\0").filter(Boolean);
}

export async function filesAheadOfBase(ctx: RepositoryContext, worktree: string): Promise<string[]> {
  const result = await ctx.run(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", `origin/${ctx.config.baseBranch}...HEAD`],
    { cwd: worktree },
  );
  return result.stdout.split("\0").filter(Boolean);
}

export async function changedFiles(ctx: RepositoryContext, worktree: string): Promise<string[]> {
  const result = await ctx.run("git", ["status", "--porcelain", "-z"], { cwd: worktree });
  const entries = result.stdout.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[1] === "R") {
      const original = entries[index + 1];
      if (original) files.push(original);
      index += 1;
    }
  }
  return files;
}

export async function hasMergeInProgress(ctx: RepositoryContext, worktree: string): Promise<boolean> {
  const mergeHead = await ctx.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
    cwd: worktree,
    allowFailure: true,
  });
  return mergeHead.exitCode === 0;
}

export async function unmergedFiles(ctx: RepositoryContext, worktree: string): Promise<string[]> {
  const result = await ctx.run("git", ["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: worktree,
  });
  return result.stdout.split("\0").filter(Boolean);
}

export async function remoteBranchRevision(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
): Promise<string | null> {
  const remote = await ctx.run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: worktree, timeoutMs: 120_000 },
  );
  return remote.stdout.trim().split(/\s+/)[0] || null;
}

export async function assertRemoteBranchRevision(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
  expectedHead: string,
): Promise<void> {
  const remoteHead = await remoteBranchRevision(ctx, worktree, branch);
  if (remoteHead !== expectedHead) {
    throw new BranchDivergenceError(
      `Remote branch moved from expected head ${expectedHead} to ${remoteHead || "missing"}`,
    );
  }
}
