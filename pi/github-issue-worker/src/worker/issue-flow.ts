import { join } from "node:path";
import { classifyIssue } from "../classification.js";
import { findLatestEvidenceRun, removeExpiredEvidence, type EvidenceRun } from "../evidence.js";
import {
  buildIssuePrompt,
  commitMessage,
  pullRequestBody,
  pullRequestTitle,
} from "../prompts.js";
import { loadQaManifest } from "../qa-manifest.js";
import type { GitHubIssue, IssueJob } from "../types.js";
import {
  createTrackedEvidence,
  finalizeEvidence,
  publishEvidence,
  runUiVerification,
  visualEvidenceNote,
} from "./evidence-flow.js";
import { ensureJobWorktree } from "./job-worktree.js";
import {
  containsUiFiles,
  errorText,
  evidenceCommentMarker,
  evidenceRequested,
  isBlockedFinalOutput,
  looksLikeUiTask,
  markdownSummary,
  RetryableControllerError,
  type WorkerContext,
} from "./shared.js";

export async function handleInitialFailure(
  ctx: WorkerContext,
  issueNumber: number,
  error: unknown,
): Promise<void> {
  if (error instanceof RetryableControllerError) {
    ctx.state.setStatus(issueNumber, "implementing", errorText(error));
    return;
  }
  await blockInitialIssue(ctx, issueNumber, error);
}

export async function labelPullRequestFromIssue(
  ctx: WorkerContext,
  prNumber: number,
  issue: GitHubIssue,
): Promise<void> {
  if (typeof ctx.github.labelPullRequestFromIssue !== "function") return;
  try {
    await ctx.github.labelPullRequestFromIssue(prNumber, issue);
    ctx.state.markProcessed(issue.number, `pr-labels:${prNumber}`);
  } catch (error) {
    throw new RetryableControllerError(
      `Pull request #${prNumber} was opened but its labels could not be synchronized: ${errorText(error)}`,
    );
  }
}

export async function processPendingPullRequestLabels(ctx: WorkerContext): Promise<void> {
  if (
    typeof ctx.github.labelPullRequestFromIssue !== "function" &&
    typeof ctx.github.activatePullRequest !== "function"
  ) {
    return;
  }
  for (const job of ctx.state.listReviewJobs()) {
    if (!job.prNumber) continue;
    const eventKey = `pr-labels:${job.prNumber}`;
    if (ctx.state.hasProcessed(eventKey)) continue;
    if (!(await ctx.github.isPullRequestOpen(job.prNumber))) continue;
    try {
      if (job.kind === "pull_request" && typeof ctx.github.activatePullRequest === "function") {
        await ensureJobWorktree(ctx, job);
        await ctx.github.activatePullRequest(job.prNumber);
        ctx.state.markProcessed(job.issueNumber, eventKey);
        continue;
      }
      const issue = await ctx.github.getIssue(job.issueNumber);
      await labelPullRequestFromIssue(ctx, job.prNumber, issue);
    } catch (error) {
      ctx.state.setStatus(
        job.issueNumber,
        "pr_open",
        `Pull request label synchronization pending: ${errorText(error)}`,
      );
    }
  }
}

export async function startIssue(ctx: WorkerContext, issue: GitHubIssue): Promise<void> {
  const branch = ctx.repository.branchForIssue(issue.number, issue.title);
  const worktreePath = ctx.repository.pathForIssue(issue.number);
  const job = ctx.state.claim(
    issue,
    branch,
    worktreePath,
    evidenceRequested(issue, ctx.config.visualLabel),
  );
  await ctx.github.claimIssue(issue.number);
  await implementIssue(ctx, issue, job);
}

export async function implementIssue(ctx: WorkerContext, issue: GitHubIssue, job: IssueJob): Promise<void> {
  const existingPull = await ctx.github.findOpenPullRequest(job.branch);
  if (existingPull) {
    await labelPullRequestFromIssue(ctx, existingPull.number, issue);
    ctx.state.setPullRequest(issue.number, existingPull.number, existingPull.url);
    await ctx.github.markPullRequestOpen(issue.number);
    return;
  }
  if (typeof ctx.github.findOpenPullRequestsForIssue === "function") {
    const overlaps = await ctx.github.findOpenPullRequestsForIssue(issue.number, job.branch);
    if (overlaps.length > 0) {
      throw new Error(
        `An existing open pull request already references issue #${issue.number}: ${overlaps.map((pull) => pull.url).join(", ")}. Review or close the overlapping work before retrying.`,
      );
    }
  }

  const worktree = await ctx.repository.ensureIssueWorktree(
    issue.number,
    job.branch,
    job.worktreePath,
  );
  ctx.state.setStatus(issue.number, "implementing");
  const visual =
    job.visualRequested ||
    evidenceRequested(issue, ctx.config.visualLabel) ||
    looksLikeUiTask(`${issue.title}\n${issue.body}`);
  if (visual) ctx.state.requestVisualEvidence(issue.number);
  let evidence: EvidenceRun | null = null;
  const sessionDir = join(ctx.config.dataDir, "sessions", `issue-${issue.number}`);
  const logFile = join(ctx.config.dataDir, "logs", `issue-${issue.number}.log`);

  let finalText = "Recovered an implementation commit after a worker restart.";
  const changedBeforeRun = await ctx.repository.changedFiles(worktree.path);
  const alreadyAhead = await ctx.repository.hasCommitsAhead(worktree.path);
  if (changedBeforeRun.length > 0 || !alreadyAhead) {
    if (visual) evidence = await createTrackedEvidence(ctx, worktree.path, issue.number, null);
    let result;
    try {
      result = await ctx.agent.run({
        worktree: worktree.path,
        sessionDir,
        sessionFile: job.sessionFile,
        prompt: buildIssuePrompt({
          config: ctx.config,
          issue,
          evidenceDir: evidence?.relativeRunDir ?? null,
          qaManifest: await loadQaManifest(worktree.path, ctx.config.qaManifestPath),
          category: classifyIssue(issue),
        }),
        logFile,
        visualVerification: evidence !== null,
        dockerAccess: ctx.config.allowDocker,
      });
    } catch (error) {
      if (evidence) {
        ctx.state.setEvidenceRunStatus(
          evidence.issueNumber,
          evidence.prNumber,
          evidence.runId,
          "invalid-terminal",
          errorText(error),
        );
      }
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
      throw new Error(
        `${errorText(error)}${await visualEvidenceNote(evidence?.runDir ?? null, evidence?.relativeRunDir ?? null)}`,
      );
    }
    ctx.state.setSession(issue.number, result.sessionFile);
    finalText = result.finalText;
    if (isBlockedFinalOutput(finalText)) {
      if (evidence) {
        ctx.state.setEvidenceRunStatus(
          evidence.issueNumber,
          evidence.prNumber,
          evidence.runId,
          "blocked",
          finalText,
        );
      }
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
      throw new Error(
        `${finalText}${await visualEvidenceNote(evidence?.runDir ?? null, evidence?.relativeRunDir ?? null)}`,
      );
    }
    if (!evidence && containsUiFiles(await ctx.repository.changedFiles(worktree.path))) {
      evidence = await runUiVerification(ctx, job, worktree.path, null);
    }
  } else {
    evidence = await findLatestEvidenceRun(worktree.path, issue.number, null);
    const recoveredUi =
      typeof ctx.repository.filesAheadOfBase === "function" &&
      containsUiFiles(await ctx.repository.filesAheadOfBase(worktree.path));
    if ((visual || recoveredUi) && !evidence) {
      evidence = await runUiVerification(ctx, job, worktree.path, null);
    }
  }

  if (evidence) {
    try {
      await finalizeEvidence(ctx, evidence);
    } catch (error) {
      await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
      throw new Error(`Visual evidence finalization failed: ${errorText(error)}`);
    }
  }
  const changedFiles = await ctx.repository.changedFiles(worktree.path);
  let controllerMutationExpected = false;
  try {
    if (changedFiles.length > 0) {
      controllerMutationExpected = true;
      await ctx.repository.commitAndPush(
        worktree.path,
        worktree.branch,
        commitMessage(issue),
      );
    } else if (await ctx.repository.hasCommitsAhead(worktree.path)) {
      controllerMutationExpected = true;
      await ctx.repository.pushIfAhead(worktree.path, worktree.branch);
    } else if (isBlockedFinalOutput(finalText)) {
      throw new Error(finalText);
    } else {
      throw new Error(
        `Pi made no tracked changes.\n\n${finalText}${await visualEvidenceNote(evidence?.runDir ?? null, evidence?.relativeRunDir ?? null)}`,
      );
    }
  } catch (error) {
    if (!controllerMutationExpected) throw error;
    throw new RetryableControllerError(errorText(error));
  }

  const pull =
    (await ctx.github.findOpenPullRequest(worktree.branch)) ??
    (await ctx.github.createDraftPullRequest(
      worktree.branch,
      pullRequestTitle(issue),
      pullRequestBody(issue, finalText),
    ));
  await labelPullRequestFromIssue(ctx, pull.number, issue);
  ctx.state.setPullRequest(issue.number, pull.number, pull.url);
  ctx.state.associatePendingEvidence(issue.number, pull.number);
  if (evidence?.prNumber === null) evidence = { ...evidence, prNumber: pull.number };
  await ctx.github.markPullRequestOpen(issue.number);
  const evidenceNote = await visualEvidenceNote(
    evidence?.runDir ?? null,
    evidence?.relativeRunDir ?? null,
  );
  await ctx.github.commentIssue(
    issue.number,
    `✅ Draft pull request opened: ${pull.url}\n\n${markdownSummary(finalText, 2_500)}${evidenceNote}`,
  );
  try {
    const publishedEvidence = await publishEvidence(ctx, pull.number, worktree.path, evidence);
    if (publishedEvidence) {
      await ctx.github.commentPullRequest(
        pull.number,
        `${evidenceCommentMarker(publishedEvidence.eventKey)}\nQA evidence attached automatically.${publishedEvidence.note}`,
      );
      ctx.state.markProcessed(issue.number, publishedEvidence.eventKey);
    }
  } catch (error) {
    ctx.state.setStatus(issue.number, "pr_open", `QA evidence publication pending: ${errorText(error)}`);
  }
  await removeExpiredEvidence(worktree.path, ctx.config.qaRetentionDays);
}

export async function blockInitialIssue(
  ctx: WorkerContext,
  issueNumber: number,
  error: unknown,
): Promise<void> {
  const message = errorText(error);
  ctx.state.setStatus(issueNumber, "blocked", message);
  await ctx.github.markBlocked(issueNumber, message).catch(() => undefined);
}
