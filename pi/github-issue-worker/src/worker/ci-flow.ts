import { ciFailureDisposition } from "../github.js";
import type { IssueJob } from "../types.js";
import { handleCiFailure, reportCiBlock } from "./ci-repair.js";
import { CONFLICT_BLOCK_PREFIX, type WorkerContext } from "./shared.js";

export async function processPullRequestCi(ctx: WorkerContext): Promise<void> {
  for (const job of ctx.state.listPullRequests()) await processCiJob(ctx, job);
}

export async function processCiJob(ctx: WorkerContext, job: IssueJob): Promise<void> {
  if (!job.prNumber) return;
  if (!(await ctx.github.isPullRequestOpen(job.prNumber))) {
    ctx.state.setStatus(job.issueNumber, "completed");
    return;
  }
  const checks = await ctx.github.getPullRequestChecks(job.prNumber);
  if (checks.state === "none") {
    const eventKey = `ci-none:${job.prNumber}:${checks.headSha}`;
    if (ctx.state.hasProcessed(eventKey)) return;
    await ctx.github.commentPullRequest(
      job.prNumber,
      "ℹ️ No PR checks are currently registered for this head. The draft remains open for human review.",
    );
    ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
    return;
  }
  if (checks.state === "pending") return;

  if (checks.state === "passed") {
    if (job.lastError?.startsWith(CONFLICT_BLOCK_PREFIX)) return;
    const eventKey = `ci-pass:${job.prNumber}:${checks.headSha}`;
    if (ctx.state.hasProcessed(eventKey)) return;
    const repairedAttempts = job.ciAttempts;
    ctx.state.resetCiAttempts(job.issueNumber, checks.headSha);
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber,
      repairedAttempts > 0
        ? `✅ CI checks passed after ${repairedAttempts} automatic repair attempt${repairedAttempts === 1 ? "" : "s"}.`
        : "✅ CI checks passed for this pull request.",
    );
    ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
    return;
  }

  const eventKey = `ci-failure:${job.prNumber}:${checks.headSha}`;
  if (ctx.state.hasProcessed(eventKey)) {
    if (["reporting_ci_block", "reporting_ci_pr_comment"].includes(job.status)) {
      ctx.state.setStatus(job.issueNumber, "pr_open", job.lastError);
    }
    return;
  }
  if (
    ["reporting_ci_block", "reporting_ci_pr_comment"].includes(job.status) &&
    job.ciHeadSha === checks.headSha &&
    job.lastError
  ) {
    await reportCiBlock(ctx, job, eventKey, job.lastError);
    return;
  }
  const recoveringCommittedHead =
    job.status === "committing_ci" && job.ciHeadSha === checks.headSha;
  const detailedChecks = await ctx.github.getPullRequestChecks(job.prNumber, true);
  if (detailedChecks.state !== "failed" || detailedChecks.headSha !== checks.headSha) return;
  const disposition = ciFailureDisposition(detailedChecks.failures);
  const rerunEventKey = `ci-rerun:${job.prNumber}:${checks.headSha}`;
  if (
    !recoveringCommittedHead &&
    disposition !== "code" &&
    !ctx.state.hasProcessed(rerunEventKey) &&
    typeof ctx.github.rerunFailedWorkflowRuns === "function"
  ) {
    const rerunCount = await ctx.github.rerunFailedWorkflowRuns(detailedChecks.failures);
    if (rerunCount > 0) {
      await ctx.github.commentPullRequest(
        job.prNumber,
        disposition === "infrastructure"
          ? `🔄 Automatically rerunning ${rerunCount} workflow run${rerunCount === 1 ? "" : "s"} that failed because of runner or GitHub Actions infrastructure.`
          : `🔄 Automatically rerunning ${rerunCount} workflow run${rerunCount === 1 ? "" : "s"} after an isolated test timeout. A repeated failure will require normal diagnosis.`,
      );
      ctx.state.markProcessed(job.issueNumber, rerunEventKey);
      return;
    }
  }
  const hasActionableFailure = checks.failures.some((failure) =>
    ["FAILURE", "ERROR"].includes(failure.conclusion),
  );
  if (!hasActionableFailure && !recoveringCommittedHead) {
    ctx.state.setCiHead(job.issueNumber, checks.headSha);
    await reportCiBlock(
      ctx,
      job,
      eventKey,
      `CI ended without an actionable code failure (${checks.failures.map((failure) => `${failure.name}: ${failure.conclusion}`).join(", ")}). Human investigation or a manual rerun is required.`,
    );
    return;
  }
  if (job.ciAttempts >= ctx.config.maxCiFixAttempts && !recoveringCommittedHead) {
    ctx.state.setCiHead(job.issueNumber, checks.headSha);
    const message = `CI is still failing after ${job.ciAttempts} automatic repair attempts. Human investigation is required.\n\nFailed checks: ${checks.failures.map((failure) => `\`${failure.name}\``).join(", ")}`;
    await reportCiBlock(ctx, job, eventKey, message);
    return;
  }
  await handleCiFailure(ctx, job, detailedChecks, eventKey);
}
