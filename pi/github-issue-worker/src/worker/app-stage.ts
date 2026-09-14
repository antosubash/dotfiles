import { randomUUID } from "node:crypto";
import type { AppInstance } from "../app-instance/index.js";
import { loadQaManifest } from "../qa-manifest.js";
import type { GitHubIssue } from "../types.js";
import { worktreeUiSurface } from "../ui-surface.js";
import type { WorkerContext } from "./shared.js";

/** Whether the browser stages of this run need the application: visual evidence was requested, or the surface is UI. */
export async function stageNeedsInstance(ctx: WorkerContext, issue: GitHubIssue, worktree: string, visual: boolean): Promise<boolean> {
  return visual || await worktreeUiSurface(issue, worktree, ctx.config.baseBranch);
}

/**
 * One app instance for every browser stage of a job run. Launched from the manifest's `launch` before
 * the first stage, stopped after the last in `finally`; without `launch`, or when no stage needs the
 * app, the stages get `null` and behave exactly as before this existed.
 */
export async function withAppInstance<T>(
  ctx: WorkerContext,
  worktree: string,
  job: { issueNumber: number },
  needsInstance: boolean,
  fn: (instance: AppInstance | null) => Promise<T>,
): Promise<T> {
  const manifest = await loadQaManifest(worktree, ctx.config.qaManifestPath);
  if (!needsInstance || !manifest?.launch) return await fn(null);
  const instance = await ctx.appInstances.start(worktree, manifest, { issueNumber: job.issueNumber, runId: randomUUID() });
  try {
    return await fn(instance);
  } finally {
    await instance.stop().catch(() => undefined);
  }
}
