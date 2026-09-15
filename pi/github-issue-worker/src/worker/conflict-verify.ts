import { basename, dirname, join } from "node:path";
import type { IssueJob } from "../types.js";
import { stageNeedsInstance, withAppInstance } from "./app-stage.js";
import { publishEvidenceDirectory } from "./evidence-flow.js";
import { errorText, evidenceCommentMarker, isInterruptedRun, markdownSummary, type WorkerContext } from "./shared.js";
import { verifyImplementationDetailed } from "./verification-flow.js";

export const POST_RESOLUTION_PASSED = "✅ Post-resolution verification passed.";
export const POST_RESOLUTION_FAILED =
  "⚠️ Post-resolution verification failed — the resolution stays pushed; CI is the other check.";

/**
 * A base-branch resolution is pushed as soon as it is resolved and checked; the independent verifier
 * runs afterwards on the shared instance. Its verdict is reported on the PR either way: a pass publishes
 * the verifier's own browser evidence, a failure is a warning, never a revert — the pushed resolution
 * is what the PR's CI and its reviewers see.
 */
export async function verifyAfterPush(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: { path: string; branch: string },
): Promise<void> {
  const prNumber = job.prNumber!;
  try {
    const issue = await ctx.github.getIssue(job.issueNumber);
    const needsInstance = () => stageNeedsInstance(ctx, issue, worktree.path, job.visualRequested);
    const outcome = await withAppInstance(ctx, worktree.path, job, needsInstance, (instance) =>
      verifyImplementationDetailed(ctx, job, worktree.path, issue, instance),
    );
    const runDir = dirname(outcome.qaReport);
    const published = await publishEvidenceDirectory(ctx, prNumber, worktree.path, join(runDir, "evidence"), basename(runDir)).catch(() => null);
    await ctx.github.commentPullRequest(
      prNumber,
      `${POST_RESOLUTION_PASSED}${outcome.text}${published ? `\n\n${evidenceCommentMarker(published.eventKey)}\nConflict-resolution QA evidence (independent verifier).${published.note}` : ""}`,
    );
    if (published) ctx.state.markProcessed(job.issueNumber, published.eventKey);
    ctx.state.setStatus(job.issueNumber, "pr_open");
  } catch (error) {
    if (isInterruptedRun(error)) throw error;
    // The resolution is already on the PR; a failed report must not escalate into the abort path.
    const reported = await ctx.github
      .commentPullRequest(prNumber, `${POST_RESOLUTION_FAILED}\n\n${markdownSummary(errorText(error))}`)
      .then(() => "", (reportError: unknown) => ` Post-resolution report pending: ${errorText(reportError)}`);
    ctx.state.setStatus(job.issueNumber, "pr_open", `${errorText(error)}${reported}`);
  }
}
