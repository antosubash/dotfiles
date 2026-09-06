import type { GitHubPullRequest } from "../types.js";
import { blockInitialIssue } from "./issue-flow.js";
import { ensureJobWorktree, validatePullRequestForAdoption } from "./job-worktree.js";
import { errorText, evidenceRequested, looksLikeUiTask, type WorkerContext } from "./shared.js";

export async function processReadyPullRequests(ctx: WorkerContext): Promise<void> {
  if (typeof ctx.github.listReadyPullRequests !== "function") return;
  const readyPullRequests = await ctx.github.listReadyPullRequests();
  for (const pullRequest of readyPullRequests) {
    const tracked = ctx.state.getJobByPullRequest(pullRequest.number);
    if (tracked) {
      try {
        validatePullRequestForAdoption(ctx, pullRequest);
        if (tracked.branch !== pullRequest.headRefName) {
          throw new Error(
            `Tracked branch ${tracked.branch} does not match ${pullRequest.headRefName}`,
          );
        }
        await ensureJobWorktree(ctx, tracked);
        if (["blocked", "stopped", "completed"].includes(tracked.status)) {
          ctx.state.setStatus(tracked.issueNumber, "pr_open");
        }
        if (typeof ctx.github.activatePullRequest === "function") {
          await ctx.github.activatePullRequest(pullRequest.number);
          ctx.state.markProcessed(tracked.issueNumber, `pr-labels:${pullRequest.number}`);
        }
      } catch (error) {
        const message = `Pull request adoption blocked: ${errorText(error)}`;
        ctx.state.setStatus(tracked.issueNumber, "blocked", message);
        await ctx.github.markBlocked(pullRequest.number, message).catch(() => undefined);
      }
      continue;
    }
    await startPullRequest(ctx, pullRequest).catch((error) =>
      blockInitialIssue(ctx, pullRequest.number, error),
    );
  }
}

export async function startPullRequest(ctx: WorkerContext, pullRequest: GitHubPullRequest): Promise<void> {
  validatePullRequestForAdoption(ctx, pullRequest);
  const worktreePath = ctx.repository.pathForPullRequest(pullRequest.number);
  const job = ctx.state.adoptPullRequest(
    pullRequest,
    worktreePath,
    evidenceRequested(pullRequest, ctx.config.visualLabel) ||
      looksLikeUiTask(`${pullRequest.title}\n${pullRequest.body}`),
  );
  await ctx.github.claimPullRequest(pullRequest);
  const worktree = await ensureJobWorktree(ctx, job);
  const head = await ctx.repository.headRevision(worktree.path);
  if (head !== pullRequest.headRefOid) {
    throw new Error(
      `Adopted worktree head ${head} does not match pull request head ${pullRequest.headRefOid}`,
    );
  }
  if (typeof ctx.github.activatePullRequest === "function") {
    await ctx.github.activatePullRequest(pullRequest.number);
    ctx.state.markProcessed(job.issueNumber, `pr-labels:${pullRequest.number}`);
  }
}
