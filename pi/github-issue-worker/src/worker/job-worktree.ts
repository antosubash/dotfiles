import type { GitHubPullRequest, IssueJob } from "../types.js";
import type { WorkerContext } from "./shared.js";

export function validatePullRequestForAdoption(ctx: WorkerContext, pullRequest: GitHubPullRequest): void {
  if (pullRequest.isCrossRepository) {
    throw new Error("Pull requests from forks cannot be adopted because the worker may only push to origin");
  }
  if (pullRequest.baseRefName !== ctx.config.baseBranch) {
    throw new Error(
      `Pull request targets ${pullRequest.baseRefName}; configured base is ${ctx.config.baseBranch}`,
    );
  }
  if (pullRequest.headRefName === ctx.config.baseBranch) {
    throw new Error("Refusing to adopt a pull request whose head is the configured base branch");
  }
}

export async function ensureJobWorktree(
  ctx: WorkerContext,
  job: IssueJob,
): Promise<{ branch: string; path: string }> {
  if (job.kind === "pull_request") {
    if (
      typeof ctx.repository.ensurePullRequestWorktree !== "function" ||
      typeof ctx.github.getPullRequest !== "function"
    ) {
      throw new Error("Worker does not support pull request worktrees");
    }
    const pullRequest = await ctx.github.getPullRequest(job.prNumber ?? job.issueNumber);
    validatePullRequestForAdoption(ctx, pullRequest);
    if (pullRequest.headRefName !== job.branch) {
      throw new Error(
        `Tracked branch ${job.branch} does not match pull request head ${pullRequest.headRefName}`,
      );
    }
    return ctx.repository.ensurePullRequestWorktree(
      job.prNumber ?? job.issueNumber,
      job.branch,
      pullRequest.headRefOid,
      job.worktreePath,
    );
  }
  return ctx.repository.ensureIssueWorktree(job.issueNumber, job.branch, job.worktreePath);
}
