import { join } from "node:path";
import { buildMergeConflictPrompt } from "../prompts.js";
import { BranchDivergenceError } from "../repository.js";
import type { IssueJob } from "../types.js";
import { assertPullRequestMergeContext, mergeConflictEventKey } from "./conflict-context.js";
import { verifyAfterPush } from "./conflict-verify.js";
import { ensureJobWorktree } from "./job-worktree.js";
import {
  CONFLICT_BLOCK_PREFIX,
  errorText,
  isBlockedFinalOutput,
  isInterruptedRun,
  markdownSummary,
  RetryableControllerError,
  type WorkerContext,
} from "./shared.js";

export async function processPullRequestConflicts(ctx: WorkerContext): Promise<boolean> {
  if (typeof ctx.github.getPullRequestMergeState !== "function") return false;
  let startedConflictResolution = false;
  for (const job of ctx.state.listPullRequests()) {
    if (!job.prNumber || !(await ctx.github.isPullRequestOpen(job.prNumber))) continue;
    const mergeState = await ctx.github.getPullRequestMergeState(job.prNumber);
    const interruptedMerge =
      typeof ctx.repository.hasMergeInProgress === "function"
        ? await ctx.repository.hasMergeInProgress(job.worktreePath).catch(() => false)
        : false;
    const conflicting =
      mergeState.mergeable === "CONFLICTING" || mergeState.mergeStateStatus === "DIRTY";
    if (!interruptedMerge && !conflicting) {
      if (
        mergeState.mergeable === "MERGEABLE" &&
        job.lastError?.startsWith(CONFLICT_BLOCK_PREFIX)
      ) {
        ctx.state.setStatus(job.issueNumber, "pr_open");
        await ctx.github.markPullRequestOpen(job.issueNumber);
        await ctx.github.commentPullRequest(
          job.prNumber,
          "✅ The base-branch conflict is no longer present. Automatic PR tracking has resumed.",
        );
      }
      continue;
    }
    const eventKey = mergeConflictEventKey(job.prNumber, mergeState);
    if (ctx.state.hasProcessed(eventKey)) continue;
    startedConflictResolution = true;
    await handleMergeConflict(
      ctx,
      job,
      mergeState.headSha,
      mergeState.baseSha,
      mergeState.baseBranch,
      eventKey,
    );
  }
  return startedConflictResolution;
}

export async function handleMergeConflict(
  ctx: WorkerContext,
  job: IssueJob,
  pullRequestHead: string,
  pullRequestBase: string,
  pullRequestBaseBranch: string,
  eventKey: string,
): Promise<void> {
  const worktree = await ensureJobWorktree(ctx, job);
  // Every path below pushes first and verifies afterwards (see conflict-verify.ts); a failure before the
  // push is what the catch block handles, a failure after it is reported on the PR and never reverted.
  try {
    if (pullRequestBaseBranch !== ctx.config.baseBranch) {
      throw new Error(
        `Pull request targets ${pullRequestBaseBranch}, but this worker is configured for ${ctx.config.baseBranch}`,
      );
    }
    const localHead = await ctx.repository.headRevision(worktree.path);
    if (localHead !== pullRequestHead) {
      await ctx.repository.recoverBaseMergePush(
        worktree.path,
        worktree.branch,
        pullRequestHead,
        pullRequestBase,
      );
      await ctx.github.markPullRequestOpen(job.issueNumber);
      await ctx.github.commentPullRequest(
        job.prNumber!,
        "🔀 Recovered and pushed an interrupted base-branch conflict resolution. Verification follows.",
      );
      ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      await verifyAfterPush(ctx, job, worktree);
      return;
    }

    const merge = await ctx.repository.beginBaseMerge(
      worktree.path,
      worktree.branch,
      pullRequestHead,
    );
    if (merge.conflicts.length === 0) {
      let pushed = false;
      if (merge.mergeInProgress) {
        // A resumed merge may hold an agent resolution that was never staged; a fresh clean merge is
        // already staged and this is a no-op either way.
        await ctx.repository.stageBaseMerge(worktree.path, worktree.branch);
        await assertPullRequestMergeContext(ctx, job.prNumber!, pullRequestHead, merge.baseSha);
        await ctx.repository.finishBaseMerge(worktree.path, worktree.branch, job.issueNumber, pullRequestHead);
        pushed = true;
      } else if (
        !merge.alreadyCurrent &&
        (await ctx.repository.hasUnpushedCommits(worktree.path, worktree.branch))
      ) {
        await ctx.repository.pushIfAhead(worktree.path, worktree.branch);
        pushed = true;
      }
      await ctx.github.markPullRequestOpen(job.issueNumber);
      await ctx.github.commentPullRequest(
        job.prNumber!,
        `🔀 Updated the feature branch from \`${ctx.config.baseBranch}\` without rebasing. No manual conflict resolution was required.${pushed ? " Verification follows." : ""}`,
      );
      ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      if (pushed) await verifyAfterPush(ctx, job, worktree);
      return;
    }

    const result = await ctx.agent.run({
      worktree: worktree.path,
      sessionDir: join(ctx.config.dataDir, "sessions", `issue-${job.issueNumber}`),
      sessionFile: job.sessionFile,
      prompt: buildMergeConflictPrompt({
        issueNumber: job.issueNumber,
        prNumber: job.prNumber!,
        baseBranch: ctx.config.baseBranch,
        baseSha: merge.baseSha,
        headSha: pullRequestHead,
        conflicts: merge.conflicts,
      }),
      logFile: join(ctx.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
      visualVerification: false,
      dockerAccess: ctx.config.allowDocker,
    });
    ctx.state.setSession(job.issueNumber, result.sessionFile);
    if (isBlockedFinalOutput(result.finalText)) throw new Error(result.finalText);
    // The agent can only edit the working tree; stage its resolution so the commit below is exactly that tree.
    await ctx.repository.stageBaseMerge(worktree.path, worktree.branch);
    await assertPullRequestMergeContext(ctx, job.prNumber!, pullRequestHead, merge.baseSha);
    await ctx.repository.finishBaseMerge(worktree.path, worktree.branch, job.issueNumber, pullRequestHead);
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      `🔀 Base-branch conflicts resolved and pushed. Verification follows.\n\n${markdownSummary(result.finalText)}`,
    );
    ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
    await verifyAfterPush(ctx, job, worktree);
  } catch (error) {
    if (isInterruptedRun(error)) throw error;
    // GitHub being unreachable says nothing about the resolution. Leave the staged merge exactly where it is:
    // the next tick sees MERGE_HEAD, resumes it and pushes.
    if (error instanceof RetryableControllerError) {
      ctx.state.setStatus(job.issueNumber, "pr_open", errorText(error));
      throw error;
    }
    const localHead = await ctx.repository.headRevision(worktree.path).catch(() => null);
    if (
      !(error instanceof BranchDivergenceError) &&
      localHead &&
      localHead !== pullRequestHead
    ) {
      ctx.state.setStatus(job.issueNumber, "pr_open", errorText(error));
      throw error;
    }
    await ctx.repository.abortBaseMerge(worktree.path).catch(() => undefined);
    // `merge --abort` keeps unstaged agent edits to auto-merged files, and beginBaseMerge refuses a dirty
    // worktree, so an abandoned resolution must be discarded outright or no retry can ever merge again.
    const discardFailure = await ctx.repository
      .clearAgentChanges(worktree.path, worktree.branch, { ignored: false })
      .then(() => "", (discardError: unknown) => ` Worktree cleanup also failed: ${errorText(discardError)}`);
    const message = `${CONFLICT_BLOCK_PREFIX} ${errorText(error)}${discardFailure}`;
    await ctx.github.markBlocked(job.issueNumber, message).catch(() => undefined);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      `⛔ I could not safely resolve the base-branch conflict. Human resolution is required.\n\n${markdownSummary(message)}`,
    );
    ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open", message);
  }
}
