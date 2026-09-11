import { join } from "node:path";
import { removeExpiredEvidence } from "../evidence.js";
import { isActionableFeedback, parseWorkerCommand } from "../github.js";
import { buildFeedbackPrompt, commitMessage } from "../prompts.js";
import { loadQaManifest } from "../qa-manifest.js";
import type { IssueJob, PullRequestFeedback } from "../types.js";
import {
  createTrackedEvidence,
  finalizeEvidence,
  publishEvidence,
  runUiVerification,
  visualEvidenceNote,
} from "./evidence-flow.js";
import { ensureJobWorktree } from "./job-worktree.js";
import { verifyImplementation } from "./verification-flow.js";
import { mergeConflictEventKey } from "./conflict-context.js";
import {
  CONFLICT_BLOCK_PREFIX,
  containsUiFiles,
  errorText,
  evidenceCommentMarker,
  isBlockedFinalOutput,
  looksLikeUiTask,
  markdownSummary,
  type WorkerContext,
} from "./shared.js";

export async function processPullRequestFeedback(ctx: WorkerContext): Promise<void> {
  for (const job of ctx.state.listReviewJobs()) await processFeedbackJob(ctx, job);
}

export async function processFeedbackJob(ctx: WorkerContext, job: IssueJob): Promise<void> {
  if (!job.prNumber) return;
  if (!(await ctx.github.isPullRequestOpen(job.prNumber))) {
    ctx.state.setStatus(job.issueNumber, "completed");
    return;
  }
  const all = await ctx.github.listFeedback(job.prNumber);
  const pending = all
    .filter(
      (item) =>
        !ctx.state.hasProcessed(item.eventKey) &&
        isActionableFeedback(item, ctx.config.trustedAssociations),
    )
    .slice(0, 20);
  if (pending.length === 0) {
    if (job.status === "addressing_review") ctx.state.setStatus(job.issueNumber, "pr_open");
    return;
  }
  await handleFeedback(ctx, job, pending);
}

export async function handleFeedback(
  ctx: WorkerContext,
  job: IssueJob,
  feedback: PullRequestFeedback[],
): Promise<void> {
  const commands = feedback
    .map((item) => parseWorkerCommand(item.body))
    .filter((command): command is string => command !== null);

  if (commands.some((command) => command === "stop")) {
    ctx.state.setStatus(job.issueNumber, "stopped");
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    await ctx.github.commentPullRequest(job.prNumber!, "🛑 Automatic work stopped for this PR.");
    return;
  }

  const onlyRetry =
    feedback.every((item) => item.source === "conversation") &&
    commands.length > 0 &&
    commands.every((command) => command === "retry");
  // A conflict block is checked before a CI block: the job may carry an older ciHeadSha as well, and the
  // conflict prefix on lastError is the specific signal. Forgetting the processed event re-queues the
  // resolution for the next tick; the agent is never handed a bare "retry" as feedback.
  if (onlyRetry && job.lastError?.startsWith(CONFLICT_BLOCK_PREFIX)) {
    const mergeState = await ctx.github.getPullRequestMergeState(job.prNumber!);
    ctx.state.forgetProcessed(mergeConflictEventKey(job.prNumber!, mergeState));
    ctx.state.setStatus(job.issueNumber, "pr_open");
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      "🔄 Base-branch conflict resolution retry queued.",
    );
    return;
  }

  const onlyCiRetry = Boolean(job.ciHeadSha && job.lastError) && onlyRetry;
  if (onlyCiRetry) {
    ctx.state.forgetProcessed(`ci-failure:${job.prNumber}:${job.ciHeadSha}`);
    ctx.state.forgetProcessed(`ci-rerun:${job.prNumber}:${job.ciHeadSha}`);
    ctx.state.resetCiAttempts(job.issueNumber, "");
    ctx.state.setStatus(job.issueNumber, "pr_open");
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      "🔄 CI repair retry queued for the current failed head.",
    );
    return;
  }

  const onlyHelp =
    feedback.every((item) => item.source === "conversation") &&
    commands.every((command) => command === "help");
  if (onlyHelp) {
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      "Commands: `/pi fix <request>`, `/pi retry`, `/pi verify visual`, `/pi verify gif`, `/pi stop`. UI work receives screenshot/GIF evidence automatically, and Docker is available automatically when the configured daemon socket exists. Formal reviews and inline review comments from trusted maintainers are handled automatically.",
    );
    return;
  }

  const issue = await ctx.github.getIssue(job.issueNumber);
  const worktree = await ensureJobWorktree(ctx, job);
  if (
    job.status === "addressing_review" &&
    (await ctx.repository.hasUnpushedCommits(worktree.path, worktree.branch))
  ) {
    try {
      await verifyImplementation(ctx, job, worktree.path, issue);
    } catch (error) {
      const message = errorText(error);
      ctx.state.setStatus(job.issueNumber, "pr_open", message);
      await ctx.github.markBlocked(job.issueNumber, message);
      await ctx.github.commentPullRequest(job.prNumber!, `⛔ Feedback recovery blocked. ${message}`);
      for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
      return;
    }
    await ctx.repository.pushIfAhead(worktree.path, worktree.branch);
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    ctx.state.setStatus(job.issueNumber, "pr_open");
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      "🔧 Recovered and pushed the interrupted feedback update.",
    );
    return;
  }

  const visualRequested =
    job.visualRequested ||
    commands.some((command) => /\b(?:visual|gif)\b/.test(command)) ||
    feedback.some((item) => looksLikeUiTask(item.body));
  if (visualRequested) ctx.state.requestVisualEvidence(job.issueNumber);
  const gifRequested = visualRequested;
  const dockerRequested = ctx.config.allowDocker;
  let evidence = visualRequested
    ? await createTrackedEvidence(ctx, worktree.path, job.issueNumber, job.prNumber)
    : null;
  ctx.state.setStatus(job.issueNumber, "addressing_review");
  let controllerPhase = false;

  try {
    const result = await ctx.agent.run({
      worktree: worktree.path,
      sessionDir: join(ctx.config.dataDir, "sessions", `issue-${job.issueNumber}`),
      sessionFile: job.sessionFile,
      prompt: buildFeedbackPrompt({
        config: ctx.config,
        issueNumber: job.issueNumber,
        prNumber: job.prNumber!,
        feedback,
        evidenceDir: evidence?.relativeRunDir ?? null,
        gifRequested,
        dockerAccess: dockerRequested,
        qaManifest: await loadQaManifest(worktree.path, ctx.config.qaManifestPath),
      }),
      logFile: join(ctx.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
      visualVerification: evidence !== null,
      dockerAccess: dockerRequested,
    });
    ctx.state.setSession(job.issueNumber, result.sessionFile);
    if (isBlockedFinalOutput(result.finalText)) {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
      throw new Error(result.finalText);
    }
    if (!evidence && containsUiFiles(await ctx.repository.changedFiles(worktree.path))) {
      evidence = await runUiVerification(ctx, job, worktree.path, job.prNumber!);
    }
    if (evidence) await finalizeEvidence(ctx, evidence);
    result.finalText += await verifyImplementation(ctx, job, worktree.path, issue);
    const gifCreated = evidence !== null;
    controllerPhase = true;
    const evidenceNote = await visualEvidenceNote(
      evidence?.runDir ?? null,
      evidence?.relativeRunDir ?? null,
    );
    const changed = await ctx.repository.changedFiles(worktree.path);
    if (changed.length > 0) {
      await ctx.repository.commitAndPush(
        worktree.path,
        worktree.branch,
        commitMessage(issue, true),
      );
    }
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    ctx.state.setStatus(job.issueNumber, "pr_open");
    await ctx.github.markPullRequestOpen(job.issueNumber);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      `✅ Feedback processed${changed.length > 0 ? " and an update was pushed" : " with no tracked code changes"}.${gifCreated ? ` GIF created at \`${evidence?.relativeRunDir}/workflow.gif\`.` : ""}\n\n${markdownSummary(result.finalText)}${evidenceNote}`,
    );
    try {
      const publishedEvidence = await publishEvidence(ctx, job.prNumber!, worktree.path, evidence);
      if (publishedEvidence) {
        await ctx.github.commentPullRequest(
          job.prNumber!,
          `${evidenceCommentMarker(publishedEvidence.eventKey)}\nQA evidence attached automatically.${publishedEvidence.note}`,
        );
        ctx.state.markProcessed(job.issueNumber, publishedEvidence.eventKey);
      }
    } catch (error) {
      ctx.state.setStatus(job.issueNumber, "pr_open", `QA evidence publication pending: ${errorText(error)}`);
    }
    await removeExpiredEvidence(worktree.path, ctx.config.qaRetentionDays);
  } catch (error) {
    const publishedEvidence = await publishEvidence(
      ctx,
      job.prNumber!,
      worktree.path,
      evidence,
    ).catch((publishError) => ({
      note: `\n\nQA evidence upload failed: ${errorText(publishError)}`,
      eventKey: "",
    }));
    const message = `${errorText(error)}${await visualEvidenceNote(
      evidence?.runDir ?? null,
      evidence?.relativeRunDir ?? null,
    )}${publishedEvidence?.note ?? ""}`;
    if (controllerPhase) {
      ctx.state.setStatus(job.issueNumber, "addressing_review", message);
      throw error;
    }
    await ctx.repository.clearAgentChanges(worktree.path, worktree.branch).catch(() => undefined);
    for (const item of feedback) ctx.state.markProcessed(job.issueNumber, item.eventKey);
    ctx.state.setStatus(job.issueNumber, "pr_open", message);
    await ctx.github.markBlocked(job.issueNumber, message).catch(() => undefined);
    await ctx.github.commentPullRequest(
      job.prNumber!,
      `⛔ I could not process this feedback. Add a new \`/pi retry\` comment after resolving the blocker.\n\n${message}`,
    );
    if (publishedEvidence?.eventKey) {
      ctx.state.markProcessed(job.issueNumber, publishedEvidence.eventKey);
    }
  }
}
