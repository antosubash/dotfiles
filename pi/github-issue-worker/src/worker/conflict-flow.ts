import { join } from "node:path";
import type { EvidenceRun } from "../evidence.js";
import { buildMergeConflictPrompt } from "../prompts.js";
import { BranchDivergenceError } from "../repository.js";
import type { IssueJob } from "../types.js";
import { publishEvidence, runUiVerification, visualEvidenceNote } from "./evidence-flow.js";
import { assertPullRequestMergeContext, mergeConflictEventKey } from "./conflict-context.js";
import { ensureJobWorktree } from "./job-worktree.js";
import { verifyImplementation } from "./verification-flow.js";
import {
  CONFLICT_BLOCK_PREFIX,
  containsUiFiles,
  errorText,
  evidenceCommentMarker,
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
  try {
    if (pullRequestBaseBranch !== ctx.config.baseBranch) {
      throw new Error(
        `Pull request targets ${pullRequestBaseBranch}, but this worker is configured for ${ctx.config.baseBranch}`,
      );
    }
    const localHead = await ctx.repository.headRevision(worktree.path);
    if (localHead !== pullRequestHead) {
      let evidence: EvidenceRun | null = null;
      if (
        typeof ctx.repository.filesChangedBetween === "function" &&
        containsUiFiles(
          await ctx.repository.filesChangedBetween(worktree.path, pullRequestHead, localHead),
        )
      ) {
        try {
          evidence = await runUiVerification(ctx, job, worktree.path, job.prNumber!);
        } catch (error) {
          throw new BranchDivergenceError(`Visual QA failed before push recovery: ${errorText(error)}`);
        }
      }
      try {
        await verifyImplementation(ctx, job, worktree.path);
      } catch (error) {
        throw new BranchDivergenceError(errorText(error));
      }
      await ctx.repository.recoverBaseMergePush(
        worktree.path,
        worktree.branch,
        pullRequestHead,
        pullRequestBase,
      );
      await ctx.github.markPullRequestOpen(job.issueNumber);
      await ctx.github.commentPullRequest(
        job.prNumber!,
        `🔀 Recovered and pushed an interrupted base-branch conflict resolution.${await visualEvidenceNote(
          evidence?.runDir ?? null,
          evidence?.relativeRunDir ?? null,
        )}`,
      );
      ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      const published = await publishEvidence(ctx, job.prNumber!, worktree.path, evidence);
      if (published) {
        await ctx.github.commentPullRequest(
          job.prNumber!,
          `${evidenceCommentMarker(published.eventKey)}\nRecovered-conflict QA evidence attached automatically.${published.note}`,
        );
        ctx.state.markProcessed(job.issueNumber, published.eventKey);
      }
      return;
    }

    const merge = await ctx.repository.beginBaseMerge(
      worktree.path,
      worktree.branch,
      pullRequestHead,
    );
    if (merge.conflicts.length === 0) {
      let evidence: EvidenceRun | null = null;
      if (merge.mergeInProgress) {
        // A resumed merge may hold an agent resolution that was never staged; a fresh clean merge is
        // already staged and this is a no-op either way.
        await ctx.repository.stageBaseMerge(worktree.path, worktree.branch);
        if (
          typeof ctx.repository.filesChangedBetween === "function" &&
          containsUiFiles(
            await ctx.repository.filesChangedBetween(worktree.path, pullRequestHead),
          )
        ) {
          evidence = await runUiVerification(ctx, job, worktree.path, job.prNumber!);
        }
        await verifyImplementation(ctx, job, worktree.path);
        await assertPullRequestMergeContext(
          ctx,
          job.prNumber!,
          pullRequestHead,
          merge.baseSha,
        );
        await ctx.repository.finishBaseMerge(
          worktree.path,
          worktree.branch,
          job.issueNumber,
          pullRequestHead,
        );
      } else if (
        !merge.alreadyCurrent &&
        (await ctx.repository.hasUnpushedCommits(worktree.path, worktree.branch))
      ) {
        await verifyImplementation(ctx, job, worktree.path);
        await ctx.repository.pushIfAhead(worktree.path, worktree.branch);
      }
      await ctx.github.markPullRequestOpen(job.issueNumber);
      await ctx.github.commentPullRequest(
        job.prNumber!,
        `🔀 Updated the feature branch from \`${ctx.config.baseBranch}\` without rebasing. No manual conflict resolution was required.${await visualEvidenceNote(
          evidence?.runDir ?? null,
          evidence?.relativeRunDir ?? null,
        )}`,
      );
      ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      const published = await publishEvidence(ctx, job.prNumber!, worktree.path, evidence);
      if (published) {
        await ctx.github.commentPullRequest(
          job.prNumber!,
          `${evidenceCommentMarker(published.eventKey)}\nBase-update QA evidence attached automatically.${published.note}`,
        );
        ctx.state.markProcessed(job.issueNumber, published.eventKey);
      }
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
    // The agent can only edit the working tree; stage its resolution now so the verifiers below inspect a
    // merge with no unmerged index entries — the exact tree that finishBaseMerge will commit.
    await ctx.repository.stageBaseMerge(worktree.path, worktree.branch);
    const evidence =
      typeof ctx.repository.filesChangedBetween === "function" &&
      containsUiFiles(await ctx.repository.filesChangedBetween(worktree.path, pullRequestHead))
        ? await runUiVerification(ctx, job, worktree.path, job.prNumber!)
        : null;
    result.finalText += await verifyImplementation(ctx, job, worktree.path);
    await assertPullRequestMergeContext(
      ctx,
      job.prNumber!,
      pullRequestHead,
      merge.baseSha,
    );
    await ctx.repository.finishBaseMerge(
      worktree.path,
      worktree.branch,
      job.issueNumber,
      pullRequestHead,
    );
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      `🔀 Base-branch conflicts resolved and pushed without rebasing. I will monitor the new checks automatically.\n\n${markdownSummary(result.finalText)}${await visualEvidenceNote(
        evidence?.runDir ?? null,
        evidence?.relativeRunDir ?? null,
      )}`,
    );
    ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
    try {
      const publishedEvidence = await publishEvidence(ctx, job.prNumber!, worktree.path, evidence);
      if (publishedEvidence) {
        await ctx.github.commentPullRequest(
          job.prNumber!,
          `${evidenceCommentMarker(publishedEvidence.eventKey)}\nConflict-resolution QA evidence attached automatically.${publishedEvidence.note}`,
        );
        ctx.state.markProcessed(job.issueNumber, publishedEvidence.eventKey);
      }
    } catch (error) {
      ctx.state.setStatus(job.issueNumber, "pr_open", `QA evidence publication pending: ${errorText(error)}`);
    }
  } catch (error) {
    if (isInterruptedRun(error)) throw error;
    // GitHub being unreachable says nothing about the resolution. Leave the staged merge exactly where it is:
    // the next tick sees MERGE_HEAD, resumes it, re-verifies (cheaply, from the cached verdict) and pushes.
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
