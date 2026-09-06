import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BranchDivergenceError, isProtectedChange, type RepositoryContext } from "./paths.js";
import {
  assertRemoteBranchRevision,
  changedFiles,
  fetchBase,
  headRevision,
  remoteBranchRevision,
  unmergedFiles,
  validateWorktree,
} from "./inspect.js";
import { pushIfAhead } from "./commits.js";

export async function beginBaseMerge(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
  expectedHead: string,
): Promise<{
  baseSha: string;
  conflicts: string[];
  alreadyCurrent: boolean;
  mergeInProgress: boolean;
}> {
  await validateWorktree(ctx, worktree, branch);
  if ((await headRevision(ctx, worktree)) !== expectedHead) {
    throw new Error(`Feature worktree moved from expected pull request head ${expectedHead}`);
  }
  await assertRemoteBranchRevision(ctx, worktree, branch, expectedHead);
  await fetchBase(ctx);
  const baseRef = `origin/${ctx.config.baseBranch}`;
  const fetchedBaseSha = (await ctx.run("git", ["rev-parse", baseRef], { cwd: worktree })).stdout.trim();
  const mergeHead = await ctx.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
    cwd: worktree,
    allowFailure: true,
  });
  let mergeInProgress = mergeHead.exitCode === 0;
  const baseSha = mergeInProgress ? mergeHead.stdout.trim() : fetchedBaseSha;
  if (mergeInProgress) {
    const trustedAncestor = await ctx.run(
      "git",
      ["merge-base", "--is-ancestor", baseSha, baseRef],
      { cwd: worktree, allowFailure: true },
    );
    if (trustedAncestor.exitCode !== 0) {
      await abortBaseMerge(ctx, worktree);
      throw new Error(`Existing merge head ${baseSha} is not part of the trusted ${baseRef} history`);
    }
  } else {
    const changed = await changedFiles(ctx, worktree);
    if (changed.length > 0) {
      throw new Error(`Cannot update from ${baseRef} with existing worktree changes: ${changed.join(", ")}`);
    }
    const current = await ctx.run("git", ["merge-base", "--is-ancestor", baseRef, "HEAD"], {
      cwd: worktree,
      allowFailure: true,
    });
    if (current.exitCode === 0) {
      return { baseSha, conflicts: [], alreadyCurrent: true, mergeInProgress: false };
    }
    const merged = await ctx.run("git", ["merge", "--no-commit", "--no-ff", baseRef], {
      cwd: worktree,
      allowFailure: true,
      timeoutMs: 10 * 60_000,
    });
    if (merged.exitCode !== 0) {
      const conflicts = await unmergedFiles(ctx, worktree);
      if (conflicts.length === 0) {
        await abortBaseMerge(ctx, worktree);
        throw new Error(`Unable to merge ${baseRef}: ${merged.stderr || merged.stdout}`);
      }
    }
    mergeInProgress = true;
  }
  const conflicts = await unmergedFiles(ctx, worktree);
  const protectedConflicts = conflicts.filter((path) =>
    isProtectedChange(path, ctx.config.protectedPaths),
  );
  if (protectedConflicts.length > 0) {
    await abortBaseMerge(ctx, worktree);
    throw new Error(`Merge conflicts touch protected paths: ${protectedConflicts.join(", ")}`);
  }
  return { baseSha, conflicts, alreadyCurrent: false, mergeInProgress };
}

export async function finishBaseMerge(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
  issueNumber: number,
  expectedHead: string,
): Promise<void> {
  await validateWorktree(ctx, worktree, branch);
  const mergeHead = await ctx.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
    cwd: worktree,
    allowFailure: true,
  });
  if (mergeHead.exitCode !== 0) throw new Error("No base merge is in progress");
  const trustedMergeBase = mergeHead.stdout.trim();
  const conflicts = await unmergedFiles(ctx, worktree);
  for (const path of conflicts) {
    const content = await readFile(join(worktree, path), "utf8").catch(() => "");
    if (/^(?:<<<<<<< |=======|>>>>>>> )/m.test(content)) {
      throw new Error(`Pi left conflict markers in ${path}`);
    }
  }
  await ctx.run("git", ["add", "--all"], { cwd: worktree });
  const unresolved = await unmergedFiles(ctx, worktree);
  if (unresolved.length > 0) {
    throw new Error(`Pi left unresolved merge conflicts: ${unresolved.join(", ")}`);
  }
  const staged = await ctx.run(
    "git",
    ["diff", "--cached", "--no-renames", "--name-only", "-z"],
    { cwd: worktree },
  );
  const stagedFiles = staged.stdout.split("\0").filter(Boolean);
  for (const path of stagedFiles) {
    const content = await readFile(join(worktree, path), "utf8").catch(() => "");
    if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======|>>>>>>> )/m.test(content)) {
      await ctx.run("git", ["reset"], { cwd: worktree });
      throw new Error(`Merge result still contains conflict markers in ${path}`);
    }
  }
  for (const path of stagedFiles.filter((candidate) =>
    isProtectedChange(candidate, ctx.config.protectedPaths),
  )) {
    const inherited = await ctx.run(
      "git",
      ["diff", "--cached", "--quiet", trustedMergeBase, "--", path],
      { cwd: worktree, allowFailure: true },
    );
    if (inherited.exitCode !== 0) {
      await ctx.run("git", ["reset"], { cwd: worktree });
      throw new Error(`Protected path differs from the trusted base during merge: ${path}`);
    }
  }
  await ctx.run("git", ["commit", "-m", `merge: update ${ctx.config.baseBranch} for #${issueNumber}`], {
    cwd: worktree,
    timeoutMs: 5 * 60_000,
  });
  await assertRemoteBranchRevision(ctx, worktree, branch, expectedHead);
  await pushIfAhead(ctx, worktree, branch);
}

export async function recoverBaseMergePush(
  ctx: RepositoryContext,
  worktree: string,
  branch: string,
  expectedHead: string,
  expectedBase: string,
): Promise<void> {
  await validateWorktree(ctx, worktree, branch);
  const localHead = await headRevision(ctx, worktree);
  const revision = (
    await ctx.run("git", ["rev-list", "--parents", "-n", "1", localHead], { cwd: worktree })
  ).stdout.trim().split(/\s+/);
  if (revision.length !== 3 || revision[1] !== expectedHead) {
    throw new BranchDivergenceError(
      `Local head ${localHead} is not the expected controller-created base merge`,
    );
  }
  const baseParent = revision[2]!;
  if (baseParent !== expectedBase) {
    throw new BranchDivergenceError(
      `Merge parent ${baseParent} does not match the expected trusted base ${expectedBase}`,
    );
  }
  const changed = await ctx.run(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", expectedHead, localHead],
    { cwd: worktree },
  );
  const changedFiles = changed.stdout.split("\0").filter(Boolean);
  for (const path of changedFiles) {
    const content = await readFile(join(worktree, path), "utf8").catch(() => "");
    if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======|>>>>>>> )/m.test(content)) {
      throw new BranchDivergenceError(`Recovered merge contains conflict markers in ${path}`);
    }
  }
  for (const path of changedFiles.filter((candidate) =>
    isProtectedChange(candidate, ctx.config.protectedPaths),
  )) {
    const inherited = await ctx.run(
      "git",
      ["diff", "--quiet", baseParent, localHead, "--", path],
      { cwd: worktree, allowFailure: true },
    );
    if (inherited.exitCode !== 0) {
      throw new BranchDivergenceError(
        `Recovered merge modified protected path beyond the trusted base: ${path}`,
      );
    }
  }
  const remoteHead = await remoteBranchRevision(ctx, worktree, branch);
  if (remoteHead === localHead) return;
  if (remoteHead !== expectedHead) {
    throw new BranchDivergenceError(
      `Remote branch moved from expected head ${expectedHead} to ${remoteHead || "missing"}`,
    );
  }
  await pushIfAhead(ctx, worktree, branch);
}

export async function abortBaseMerge(ctx: RepositoryContext, worktree: string): Promise<void> {
  const mergeHead = await ctx.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
    cwd: worktree,
    allowFailure: true,
  });
  if (mergeHead.exitCode === 0) {
    await ctx.run("git", ["merge", "--abort"], { cwd: worktree, allowFailure: true });
  }
}
