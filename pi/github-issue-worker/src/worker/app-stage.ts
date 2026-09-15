import { randomUUID } from "node:crypto";
import type { AppInstance } from "../app-instance/index.js";
import { memoryDirectory, writeMemoryNote } from "../project-memory.js";
import { loadWorkerQaManifest } from "../qa-manifest-source.js";
import type { QaManifest } from "../qa-manifest.js";
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
 * app, the stages get `null` and behave exactly as before this existed. A caller that already loaded the
 * manifest for this run passes it in, so the run's earlier decisions (whether the implementer captured
 * evidence itself) and this one are made from the same manifest, not from a file re-read later.
 */
export async function withAppInstance<T>(
  ctx: WorkerContext,
  worktree: string,
  job: { issueNumber: number },
  needsInstance: boolean | (() => Promise<boolean>),
  fn: (instance: AppInstance | null) => Promise<T>,
  loaded?: QaManifest | null,
): Promise<T> {
  const manifest = loaded === undefined ? await loadWorkerQaManifest(ctx.config, worktree) : loaded;
  // The need check inspects the worktree's diff; it is only consulted once a launcher exists to run.
  if (!manifest?.launch || !(typeof needsInstance === "function" ? await needsInstance() : needsInstance)) return await fn(null);
  const instance = await ctx.appInstances.start(worktree, manifest, {
    issueNumber: job.issueNumber,
    runId: randomUUID(),
    // The next run's expectations are informed by what this one measured; a failure to save that note
    // must not fail the run, but it must not be silent either.
    onStarted: (summary) => writeMemoryNote(
      memoryDirectory(ctx.config),
      "instance-timing",
      "App instance timing (harness-written)",
      `Last launch ready after ${Math.round(summary.readinessMs / 1000)} s (run ${summary.runId}); auth ${summary.storageState ? "set up" : "not declared"}.`,
    ).catch((error) =>
      console.error(`${new Date().toISOString()} failed to write app instance timing note: ${error instanceof Error ? error.message : String(error)}`),
    ),
  });
  try {
    return await fn(instance);
  } finally {
    await instance.stop().catch(() => undefined);
  }
}
