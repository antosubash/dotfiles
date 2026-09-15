import { join } from "node:path";
import { buildCiFailurePrompt, commitMessage } from "../prompts.js";
import { loadWorkerQaManifest } from "../qa-manifest-source.js";
import type { IssueJob, PullRequestChecks } from "../types.js";
import {
  createTrackedEvidence,
  finalizeEvidence,
  publishBlockedEvidence,
  publishEvidence,
  runUiVerification,
  visualEvidenceNote,
} from "./evidence-flow.js";
import { ensureJobWorktree } from "./job-worktree.js";
import { verifyImplementation } from "./verification-flow.js";
import {
  containsUiFiles,
  errorText,
  evidenceCommentMarker,
  isBlockedFinalOutput,
  isInterruptedRun,
  markdownSummary,
  type WorkerContext,
} from "./shared.js";

export async function handleCiFailure(
  ctx: WorkerContext,
  job: IssueJob,
  checks: PullRequestChecks,
  eventKey: string,
): Promise<void> {
  const worktree = await ensureJobWorktree(ctx, job);
  const recoveringCommittedHead =
    job.status === "committing_ci" && job.ciHeadSha === checks.headSha;
  const attempt = ctx.state.recordCiAttempt(job.issueNumber, checks.headSha);

  if (recoveringCommittedHead) {
    try {
      const issue = await ctx.github.getIssue(job.issueNumber);
      await verifyImplementation(ctx, job, worktree.path, issue);
      const unpushed = await ctx.repository.hasUnpushedCommits(worktree.path, worktree.branch);
      if (unpushed) {
        await ctx.repository.pushIfAhead(worktree.path, worktree.branch);
      } else if ((await ctx.repository.changedFiles(worktree.path)).length > 0) {
        await ctx.repository.commitAndPush(
          worktree.path,
          worktree.branch,
          commitMessage(issue, true),
        );
      } else if ((await ctx.repository.headRevision(worktree.path)) === checks.headSha) {
        await reportCiBlock(
          ctx,
          job,
          eventKey,
          "CI repair recovery found no committed or uncommitted repair to push.",
        );
        return;
      }
    } catch (error) {
      await reportCiBlock(
        ctx,
        job,
        eventKey,
        `Committed CI repair recovery requires human help: ${errorText(error)}`,
      );
      return;
    }
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      `🔧 Recovered and pushed CI repair attempt ${attempt}. I will monitor the new checks automatically.`,
    );
    ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
    return;
  }

  ctx.state.setStatus(job.issueNumber, "addressing_ci");
  const issue = await ctx.github.getIssue(job.issueNumber);
  const ciVisual =
    job.visualRequested ||
    checks.failures.some((failure) =>
      /\b(?:browser|chromium|e2e|playwright|visual|frontend|ui)\b/i.test(failure.name),
    );
  if (ciVisual) ctx.state.requestVisualEvidence(job.issueNumber);
  let evidence = ciVisual
    ? await createTrackedEvidence(ctx, worktree.path, job.issueNumber, job.prNumber)
    : null;
  let result;
  try {
    result = await ctx.agent.run({
      worktree: worktree.path,
      sessionDir: join(ctx.config.dataDir, "sessions", `issue-${job.issueNumber}`),
      sessionFile: job.sessionFile,
      prompt: buildCiFailurePrompt({
        config: ctx.config,
        issueNumber: job.issueNumber,
        prNumber: job.prNumber!,
        headSha: checks.headSha,
        attempt,
        failures: checks.failures,
        evidenceDir: evidence?.relativeRunDir ?? null,
        qaManifest: await loadWorkerQaManifest(ctx.config, worktree.path),
      }),
      logFile: join(ctx.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
      visualVerification: ciVisual,
      dockerAccess: ctx.config.allowDocker,
    });
  } catch (error) {
    if (isInterruptedRun(error)) {
      ctx.state.setStatus(job.issueNumber, "addressing_ci", errorText(error));
      throw error;
    }
    let message = `Pi CI repair failed: ${errorText(error)}${await publishBlockedEvidence(
      ctx,
      job,
      worktree.path,
      evidence,
    )}`;
    try {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
    } catch (cleanupError) {
      message += `\n\nController cleanup also failed: ${errorText(cleanupError)}`;
    }
    await reportCiBlock(ctx, job, eventKey, message);
    return;
  }
  ctx.state.setSession(job.issueNumber, result.sessionFile);
  if (isBlockedFinalOutput(result.finalText)) {
    let message = `${result.finalText}${await publishBlockedEvidence(
      ctx,
      job,
      worktree.path,
      evidence,
    )}`;
    try {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
    } catch (error) {
      message += `\n\nController cleanup also failed: ${errorText(error)}`;
    }
    await reportCiBlock(ctx, job, eventKey, message);
    return;
  }

  if (!evidence && containsUiFiles(await ctx.repository.changedFiles(worktree.path))) {
    try {
      evidence = await runUiVerification(ctx, job, worktree.path, job.prNumber!);
    } catch (error) {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch).catch(() => undefined);
      await reportCiBlock(ctx, job, eventKey, `Visual QA failed: ${errorText(error)}`);
      return;
    }
  }
  if (evidence) {
    try {
      await finalizeEvidence(ctx, evidence);
    } catch (error) {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch).catch(() => undefined);
      await reportCiBlock(ctx, job, eventKey, `Visual evidence finalization failed: ${errorText(error)}`);
      return;
    }
  }

  try {
    result.finalText += await verifyImplementation(ctx, job, worktree.path, issue);
  } catch (error) {
    await ctx.repository.clearAgentChanges(worktree.path, worktree.branch).catch(() => undefined);
    await reportCiBlock(ctx, job, eventKey, errorText(error));
    return;
  }
  ctx.state.setStatus(job.issueNumber, "committing_ci");
  let changed: string[];
  try {
    changed = await ctx.repository.changedFiles(worktree.path);
    if (changed.length > 0) {
      await ctx.repository.commitAndPush(worktree.path, worktree.branch, commitMessage(issue, true));
    }
  } catch (error) {
    ctx.state.setStatus(job.issueNumber, "committing_ci", errorText(error));
    throw error;
  }
  if (changed.length === 0) {
    let message = `Pi made no tracked changes for the failing CI checks.\n\n${result.finalText}${await publishBlockedEvidence(
      ctx,
      job,
      worktree.path,
      evidence,
    )}`;
    try {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
    } catch (error) {
      message += `\n\nController cleanup also failed: ${errorText(error)}`;
    }
    await reportCiBlock(ctx, job, eventKey, message);
    return;
  }

  const evidenceNote = await visualEvidenceNote(
    evidence?.runDir ?? null,
    evidence?.relativeRunDir ?? null,
  );
  await ctx.github.markPullRequestOpen(job.issueNumber);
  await ctx.github.commentPullRequest(
    job.prNumber!,
    `🔧 CI repair attempt ${attempt} pushed. I will monitor the new checks automatically.\n\n${markdownSummary(result.finalText)}${evidenceNote}`,
  );
  ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
  try {
    const publishedEvidence = await publishEvidence(ctx, job.prNumber!, worktree.path, evidence);
    if (publishedEvidence) {
      await ctx.github.commentPullRequest(
        job.prNumber!,
        `${evidenceCommentMarker(publishedEvidence.eventKey)}\nCI repair QA evidence attached automatically.${publishedEvidence.note}`,
      );
      ctx.state.markProcessed(job.issueNumber, publishedEvidence.eventKey);
    }
  } catch (error) {
    ctx.state.setStatus(job.issueNumber, "pr_open", `QA evidence publication pending: ${errorText(error)}`);
  }
}

export async function reportCiBlock(
  ctx: WorkerContext,
  job: IssueJob,
  eventKey: string,
  message: string,
): Promise<void> {
  const summary = markdownSummary(message);
  if (job.status !== "reporting_ci_pr_comment") {
    ctx.state.setStatus(job.issueNumber, "reporting_ci_block", summary);
    await ctx.github.markBlocked(job.issueNumber, summary);
    ctx.state.setStatus(job.issueNumber, "reporting_ci_pr_comment", summary);
  }
  await ctx.github.commentPullRequest(
    job.prNumber!,
    `⛔ Automatic CI repair could not continue. Add a new \`/pi retry\` comment after resolving the blocker.\n\n${summary}`,
  );
  ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open", summary);
}
