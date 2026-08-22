import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "./config.js";
import { convertWebmToGif, createEvidenceRun, removeExpiredEvidence } from "./evidence.js";
import {
  GitHubClient,
  isActionableFeedback,
  parseWorkerCommand,
} from "./github.js";
import { PiAgentRunner } from "./pi-agent.js";
import {
  buildCiFailurePrompt,
  buildFeedbackPrompt,
  buildIssuePrompt,
  buildMergeConflictPrompt,
  commitMessage,
  pullRequestBody,
  pullRequestTitle,
} from "./prompts.js";
import { BranchDivergenceError, RepositoryManager } from "./repository.js";
import { WorkerState } from "./state.js";
import type {
  GitHubIssue,
  IssueJob,
  PullRequestChecks,
  PullRequestFeedback,
} from "./types.js";

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message;
}

class RetryableControllerError extends Error {}

const CONFLICT_BLOCK_PREFIX = "Automatic base-branch conflict resolution failed:";

function isInterruptedRun(error: unknown): boolean {
  return /(?:^|\b)(?:aborted|sigint|sigterm|shutdown|terminated by signal)(?:\b|$)/i.test(
    errorText(error),
  );
}

function evidenceRequested(issue: GitHubIssue, visualLabel: string): boolean {
  return issue.labels.some((label) => label.name.toLowerCase() === visualLabel.toLowerCase());
}

async function finishRequestedGif(runDir: string | null): Promise<boolean> {
  if (!runDir) return false;
  const webm = join(runDir, "workflow.webm");
  const gif = join(runDir, "workflow.gif");
  const hasWebm = await access(webm)
    .then(() => true)
    .catch(() => false);
  if (!hasWebm) return false;
  await convertWebmToGif(webm, gif);
  return true;
}

async function visualEvidenceNote(
  runDir: string | null,
  relativeRunDir: string | null,
): Promise<string> {
  if (!runDir || !relativeRunDir) return "";
  const artifacts = (await readdir(runDir).catch(() => []))
    .filter((name) => /\.(?:png|gif|webm|md|txt)$/i.test(name))
    .sort();
  if (artifacts.length === 0) {
    return `\n\nVisual evidence directory (local, ignored): \`${relativeRunDir}\` (no capture artifact was produced).`;
  }
  return `\n\nVisual evidence captured locally under ignored \`${relativeRunDir}\`:\n${artifacts.map((name) => `- \`${name}\``).join("\n")}`;
}

function markdownSummary(text: string, maximum = 5_000): string {
  if (!text) return "Pi returned no textual summary.";
  return text.length > maximum ? `${text.slice(0, maximum)}\n\n…truncated` : text;
}

export function isBlockedFinalOutput(text: string): boolean {
  return /^\s*(?:[#>*-]\s*)*(?:\*\*|__)?BLOCKED\b/im.test(text);
}

export class IssueWorker {
  private readonly github: GitHubClient;
  private readonly repository: RepositoryManager;
  private readonly agent: PiAgentRunner;

  constructor(
    private readonly config: WorkerConfig,
    private readonly state: WorkerState,
    dependencies: {
      github?: GitHubClient;
      repository?: RepositoryManager;
      agent?: PiAgentRunner;
    } = {},
  ) {
    this.github = dependencies.github ?? new GitHubClient(config);
    this.repository = dependencies.repository ?? new RepositoryManager(config);
    this.agent = dependencies.agent ?? new PiAgentRunner(config);
  }

  async check(): Promise<void> {
    await this.github.assertAuthenticated();
    await this.agent.assertAvailable();
  }

  async initialize(): Promise<void> {
    await this.check();
    await this.github.ensureLabels();
    await this.repository.ensureControlRepository();
  }

  async tick(): Promise<void> {
    await this.resumeInterruptedIssues();
    const readyIssues = await this.github.listReadyIssues();
    for (const issue of readyIssues) {
      const current = this.state.getJob(issue.number);
      if (
        current &&
        [
          "claimed",
          "implementing",
          "pr_open",
          "addressing_review",
          "addressing_ci",
          "committing_ci",
          "reporting_ci_block",
          "reporting_ci_pr_comment",
        ].includes(current.status)
      ) {
        continue;
      }
      await this.startIssue(issue).catch((error) => this.handleInitialFailure(issue.number, error));
    }
    if (await this.processPullRequestConflicts()) return;
    await this.processPullRequestFeedback();
    await this.processPullRequestCi();
  }

  private async resumeInterruptedIssues(): Promise<void> {
    for (const job of this.state.listActive()) {
      if (job.status === "addressing_review" && job.prNumber) {
        await this.processFeedbackJob(job);
        continue;
      }
      if (
        [
          "addressing_ci",
          "committing_ci",
          "reporting_ci_block",
          "reporting_ci_pr_comment",
        ].includes(job.status) &&
        job.prNumber
      ) {
        await this.processCiJob(job);
        continue;
      }
      if (job.prNumber || !["claimed", "implementing"].includes(job.status)) continue;
      const issue = await this.github.getIssue(job.issueNumber);
      await this.implementIssue(issue, job).catch((error) =>
        this.handleInitialFailure(job.issueNumber, error),
      );
    }
  }

  private async handleInitialFailure(issueNumber: number, error: unknown): Promise<void> {
    if (error instanceof RetryableControllerError) {
      this.state.setStatus(issueNumber, "implementing", errorText(error));
      return;
    }
    await this.blockInitialIssue(issueNumber, error);
  }

  private async startIssue(issue: GitHubIssue): Promise<void> {
    const branch = this.repository.branchForIssue(issue.number, issue.title);
    const worktreePath = this.repository.pathForIssue(issue.number);
    const job = this.state.claim(
      issue,
      branch,
      worktreePath,
      evidenceRequested(issue, this.config.visualLabel),
    );
    await this.github.claimIssue(issue.number);
    await this.implementIssue(issue, job);
  }

  private async implementIssue(issue: GitHubIssue, job: IssueJob): Promise<void> {
    const existingPull = await this.github.findOpenPullRequest(job.branch);
    if (existingPull) {
      this.state.setPullRequest(issue.number, existingPull.number, existingPull.url);
      await this.github.markPullRequestOpen(issue.number);
      return;
    }

    const worktree = await this.repository.ensureIssueWorktree(
      issue.number,
      job.branch,
      job.worktreePath,
    );
    this.state.setStatus(issue.number, "implementing");
    const visual = job.visualRequested || evidenceRequested(issue, this.config.visualLabel);
    const evidence = visual
      ? await createEvidenceRun(worktree.path, issue.number, null)
      : null;
    const sessionDir = join(this.config.dataDir, "sessions", `issue-${issue.number}`);
    const logFile = join(this.config.dataDir, "logs", `issue-${issue.number}.log`);

    let finalText = "Recovered an implementation commit after a worker restart.";
    const changedBeforeRun = await this.repository.changedFiles(worktree.path);
    const alreadyAhead = await this.repository.hasCommitsAhead(worktree.path);
    if (changedBeforeRun.length > 0 || !alreadyAhead) {
      let result;
      try {
        result = await this.agent.run({
          worktree: worktree.path,
          sessionDir,
          sessionFile: job.sessionFile,
          prompt: buildIssuePrompt({
            config: this.config,
            issue,
            evidenceDir: evidence?.relativeRunDir ?? null,
          }),
          logFile,
          visualVerification: evidence !== null,
        });
      } catch (error) {
        await this.repository.clearAgentChanges(worktree.path, worktree.branch);
        throw new Error(
          `${errorText(error)}${await visualEvidenceNote(evidence?.runDir ?? null, evidence?.relativeRunDir ?? null)}`,
        );
      }
      this.state.setSession(issue.number, result.sessionFile);
      finalText = result.finalText;
      if (isBlockedFinalOutput(finalText)) {
        await this.repository.clearAgentChanges(worktree.path, worktree.branch);
        throw new Error(
          `${finalText}${await visualEvidenceNote(evidence?.runDir ?? null, evidence?.relativeRunDir ?? null)}`,
        );
      }
    }

    const changedFiles = await this.repository.changedFiles(worktree.path);
    let controllerMutationExpected = false;
    try {
      if (changedFiles.length > 0) {
        controllerMutationExpected = true;
        await this.repository.commitAndPush(
          worktree.path,
          worktree.branch,
          commitMessage(issue),
        );
      } else if (await this.repository.hasCommitsAhead(worktree.path)) {
        controllerMutationExpected = true;
        await this.repository.pushIfAhead(worktree.path, worktree.branch);
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
      (await this.github.findOpenPullRequest(worktree.branch)) ??
      (await this.github.createDraftPullRequest(
        worktree.branch,
        pullRequestTitle(issue),
        pullRequestBody(issue, finalText),
      ));
    this.state.setPullRequest(issue.number, pull.number, pull.url);
    await this.github.markPullRequestOpen(issue.number);
    const evidenceNote = await visualEvidenceNote(
      evidence?.runDir ?? null,
      evidence?.relativeRunDir ?? null,
    );
    await this.github.commentIssue(
      issue.number,
      `✅ Draft pull request opened: ${pull.url}\n\n${markdownSummary(finalText, 2_500)}${evidenceNote}`,
    );
    await removeExpiredEvidence(worktree.path, this.config.qaRetentionDays);
  }

  private async blockInitialIssue(issueNumber: number, error: unknown): Promise<void> {
    const message = errorText(error);
    this.state.setStatus(issueNumber, "blocked", message);
    await this.github.markBlocked(issueNumber, message).catch(() => undefined);
  }

  private async processPullRequestConflicts(): Promise<boolean> {
    if (typeof this.github.getPullRequestMergeState !== "function") return false;
    let startedConflictResolution = false;
    for (const job of this.state.listPullRequests()) {
      if (!job.prNumber || !(await this.github.isPullRequestOpen(job.prNumber))) continue;
      const mergeState = await this.github.getPullRequestMergeState(job.prNumber);
      const interruptedMerge =
        typeof this.repository.hasMergeInProgress === "function"
          ? await this.repository.hasMergeInProgress(job.worktreePath).catch(() => false)
          : false;
      const conflicting =
        mergeState.mergeable === "CONFLICTING" || mergeState.mergeStateStatus === "DIRTY";
      if (!interruptedMerge && !conflicting) {
        if (
          mergeState.mergeable === "MERGEABLE" &&
          job.lastError?.startsWith(CONFLICT_BLOCK_PREFIX)
        ) {
          this.state.setStatus(job.issueNumber, "pr_open");
          await this.github.markPullRequestOpen(job.issueNumber);
          await this.github.commentPullRequest(
            job.prNumber,
            "✅ The base-branch conflict is no longer present. Automatic PR tracking has resumed.",
          );
        }
        continue;
      }
      const eventKey = `merge-conflict:${job.prNumber}:${mergeState.baseBranch}:${mergeState.headSha}:${mergeState.baseSha}`;
      if (this.state.hasProcessed(eventKey)) continue;
      startedConflictResolution = true;
      await this.handleMergeConflict(
        job,
        mergeState.headSha,
        mergeState.baseSha,
        mergeState.baseBranch,
        eventKey,
      );
    }
    return startedConflictResolution;
  }

  private async handleMergeConflict(
    job: IssueJob,
    pullRequestHead: string,
    pullRequestBase: string,
    pullRequestBaseBranch: string,
    eventKey: string,
  ): Promise<void> {
    const worktree = await this.repository.ensureIssueWorktree(
      job.issueNumber,
      job.branch,
      job.worktreePath,
    );
    try {
      if (pullRequestBaseBranch !== this.config.baseBranch) {
        throw new Error(
          `Pull request targets ${pullRequestBaseBranch}, but this worker is configured for ${this.config.baseBranch}`,
        );
      }
      const localHead = await this.repository.headRevision(worktree.path);
      if (localHead !== pullRequestHead) {
        await this.repository.recoverBaseMergePush(
          worktree.path,
          worktree.branch,
          pullRequestHead,
          pullRequestBase,
        );
        await this.github.markPullRequestOpen(job.issueNumber);
        await this.github.commentPullRequest(
          job.prNumber!,
          "🔀 Recovered and pushed an interrupted base-branch conflict resolution.",
        );
        this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
        return;
      }

      const merge = await this.repository.beginBaseMerge(
        worktree.path,
        worktree.branch,
        pullRequestHead,
      );
      if (merge.conflicts.length === 0) {
        if (merge.mergeInProgress) {
          await this.assertPullRequestMergeContext(
            job.prNumber!,
            pullRequestHead,
            merge.baseSha,
          );
          await this.repository.finishBaseMerge(
            worktree.path,
            worktree.branch,
            job.issueNumber,
            pullRequestHead,
          );
        } else if (
          !merge.alreadyCurrent &&
          (await this.repository.hasUnpushedCommits(worktree.path, worktree.branch))
        ) {
          await this.repository.pushIfAhead(worktree.path, worktree.branch);
        }
        await this.github.markPullRequestOpen(job.issueNumber);
        await this.github.commentPullRequest(
          job.prNumber!,
          `🔀 Updated the feature branch from \`${this.config.baseBranch}\` without rebasing. No manual conflict resolution was required.`,
        );
        this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
        return;
      }

      const result = await this.agent.run({
        worktree: worktree.path,
        sessionDir: join(this.config.dataDir, "sessions", `issue-${job.issueNumber}`),
        sessionFile: job.sessionFile,
        prompt: buildMergeConflictPrompt({
          issueNumber: job.issueNumber,
          prNumber: job.prNumber!,
          baseBranch: this.config.baseBranch,
          baseSha: merge.baseSha,
          headSha: pullRequestHead,
          conflicts: merge.conflicts,
        }),
        logFile: join(this.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
        visualVerification: false,
      });
      this.state.setSession(job.issueNumber, result.sessionFile);
      if (isBlockedFinalOutput(result.finalText)) throw new Error(result.finalText);
      await this.assertPullRequestMergeContext(
        job.prNumber!,
        pullRequestHead,
        merge.baseSha,
      );
      await this.repository.finishBaseMerge(
        worktree.path,
        worktree.branch,
        job.issueNumber,
        pullRequestHead,
      );
      await this.github.markPullRequestOpen(job.issueNumber);
      await this.github.commentPullRequest(
        job.prNumber!,
        `🔀 Base-branch conflicts resolved and pushed without rebasing. I will monitor the new checks automatically.\n\n${markdownSummary(result.finalText)}`,
      );
      this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
    } catch (error) {
      if (isInterruptedRun(error)) throw error;
      const localHead = await this.repository.headRevision(worktree.path).catch(() => null);
      if (
        !(error instanceof BranchDivergenceError) &&
        localHead &&
        localHead !== pullRequestHead
      ) {
        this.state.setStatus(job.issueNumber, "pr_open", errorText(error));
        throw error;
      }
      await this.repository.abortBaseMerge(worktree.path).catch(() => undefined);
      const message = `${CONFLICT_BLOCK_PREFIX} ${errorText(error)}`;
      await this.github.markBlocked(job.issueNumber, message).catch(() => undefined);
      await this.github.commentPullRequest(
        job.prNumber!,
        `⛔ I could not safely resolve the base-branch conflict. Human resolution is required.\n\n${markdownSummary(message)}`,
      );
      this.state.completeEvent(job.issueNumber, eventKey, "pr_open", message);
    }
  }

  private async assertPullRequestMergeContext(
    prNumber: number,
    expectedHead: string,
    expectedBase: string,
  ): Promise<void> {
    const current = await this.github.getPullRequestMergeState(prNumber);
    if (
      current.baseBranch !== this.config.baseBranch ||
      current.headSha !== expectedHead ||
      current.baseSha !== expectedBase
    ) {
      throw new BranchDivergenceError(
        `Pull request merge context moved while resolving conflicts (base ${current.baseBranch}@${current.baseSha}, head ${current.headSha})`,
      );
    }
  }

  private async processPullRequestFeedback(): Promise<void> {
    for (const job of this.state.listReviewJobs()) await this.processFeedbackJob(job);
  }

  private async processPullRequestCi(): Promise<void> {
    for (const job of this.state.listPullRequests()) await this.processCiJob(job);
  }

  private async processCiJob(job: IssueJob): Promise<void> {
    if (!job.prNumber) return;
    if (!(await this.github.isPullRequestOpen(job.prNumber))) {
      this.state.setStatus(job.issueNumber, "completed");
      return;
    }
    const checks = await this.github.getPullRequestChecks(job.prNumber);
    if (checks.state === "none") {
      const eventKey = `ci-none:${job.prNumber}:${checks.headSha}`;
      if (this.state.hasProcessed(eventKey)) return;
      await this.github.commentPullRequest(
        job.prNumber,
        "ℹ️ No PR checks are currently registered for this head. The draft remains open for human review.",
      );
      this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      return;
    }
    if (checks.state === "pending") return;

    if (checks.state === "passed") {
      if (job.lastError?.startsWith(CONFLICT_BLOCK_PREFIX)) return;
      const eventKey = `ci-pass:${job.prNumber}:${checks.headSha}`;
      if (this.state.hasProcessed(eventKey)) return;
      const repairedAttempts = job.ciAttempts;
      this.state.resetCiAttempts(job.issueNumber, checks.headSha);
      await this.github.markPullRequestOpen(job.issueNumber);
      await this.github.commentPullRequest(
        job.prNumber,
        repairedAttempts > 0
          ? `✅ CI checks passed after ${repairedAttempts} automatic repair attempt${repairedAttempts === 1 ? "" : "s"}.`
          : "✅ CI checks passed for this pull request.",
      );
      this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      return;
    }

    const eventKey = `ci-failure:${job.prNumber}:${checks.headSha}`;
    if (this.state.hasProcessed(eventKey)) {
      if (["reporting_ci_block", "reporting_ci_pr_comment"].includes(job.status)) {
        this.state.setStatus(job.issueNumber, "pr_open", job.lastError);
      }
      return;
    }
    if (
      ["reporting_ci_block", "reporting_ci_pr_comment"].includes(job.status) &&
      job.ciHeadSha === checks.headSha &&
      job.lastError
    ) {
      await this.reportCiBlock(job, eventKey, job.lastError);
      return;
    }
    const recoveringCommittedHead =
      job.status === "committing_ci" && job.ciHeadSha === checks.headSha;
    const hasActionableFailure = checks.failures.some((failure) =>
      ["FAILURE", "ERROR"].includes(failure.conclusion),
    );
    if (!hasActionableFailure && !recoveringCommittedHead) {
      this.state.setCiHead(job.issueNumber, checks.headSha);
      await this.reportCiBlock(
        job,
        eventKey,
        `CI ended without an actionable code failure (${checks.failures.map((failure) => `${failure.name}: ${failure.conclusion}`).join(", ")}). Human investigation or a manual rerun is required.`,
      );
      return;
    }
    if (job.ciAttempts >= this.config.maxCiFixAttempts && !recoveringCommittedHead) {
      this.state.setCiHead(job.issueNumber, checks.headSha);
      const message = `CI is still failing after ${job.ciAttempts} automatic repair attempts. Human investigation is required.\n\nFailed checks: ${checks.failures.map((failure) => `\`${failure.name}\``).join(", ")}`;
      await this.reportCiBlock(job, eventKey, message);
      return;
    }
    const detailedChecks = await this.github.getPullRequestChecks(job.prNumber, true);
    if (detailedChecks.state !== "failed" || detailedChecks.headSha !== checks.headSha) return;
    await this.handleCiFailure(job, detailedChecks, eventKey);
  }

  private async handleCiFailure(
    job: IssueJob,
    checks: PullRequestChecks,
    eventKey: string,
  ): Promise<void> {
    const worktree = await this.repository.ensureIssueWorktree(
      job.issueNumber,
      job.branch,
      job.worktreePath,
    );
    const recoveringCommittedHead =
      job.status === "committing_ci" && job.ciHeadSha === checks.headSha;
    const attempt = this.state.recordCiAttempt(job.issueNumber, checks.headSha);

    if (recoveringCommittedHead) {
      try {
        const issue = await this.github.getIssue(job.issueNumber);
        const unpushed = await this.repository.hasUnpushedCommits(worktree.path, worktree.branch);
        if (unpushed) {
          await this.repository.pushIfAhead(worktree.path, worktree.branch);
        } else if ((await this.repository.changedFiles(worktree.path)).length > 0) {
          await this.repository.commitAndPush(
            worktree.path,
            worktree.branch,
            commitMessage(issue, true),
          );
        } else if ((await this.repository.headRevision(worktree.path)) === checks.headSha) {
          await this.reportCiBlock(
            job,
            eventKey,
            "CI repair recovery found no committed or uncommitted repair to push.",
          );
          return;
        }
      } catch (error) {
        await this.reportCiBlock(
          job,
          eventKey,
          `Committed CI repair recovery requires human help: ${errorText(error)}`,
        );
        return;
      }
      await this.github.markPullRequestOpen(job.issueNumber);
      await this.github.commentPullRequest(
        job.prNumber!,
        `🔧 Recovered and pushed CI repair attempt ${attempt}. I will monitor the new checks automatically.`,
      );
      this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
      return;
    }

    this.state.setStatus(job.issueNumber, "addressing_ci");
    const issue = await this.github.getIssue(job.issueNumber);
    let result;
    try {
      result = await this.agent.run({
        worktree: worktree.path,
        sessionDir: join(this.config.dataDir, "sessions", `issue-${job.issueNumber}`),
        sessionFile: job.sessionFile,
        prompt: buildCiFailurePrompt({
          issueNumber: job.issueNumber,
          prNumber: job.prNumber!,
          headSha: checks.headSha,
          attempt,
          failures: checks.failures,
        }),
        logFile: join(this.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
        visualVerification:
          job.visualRequested ||
          checks.failures.some((failure) =>
            /\b(?:browser|chromium|e2e|playwright|visual)\b/i.test(failure.name),
          ),
      });
    } catch (error) {
      if (isInterruptedRun(error)) {
        this.state.setStatus(job.issueNumber, "addressing_ci", errorText(error));
        throw error;
      }
      let message = `Pi CI repair failed: ${errorText(error)}`;
      try {
        await this.repository.clearAgentChanges(worktree.path, worktree.branch);
      } catch (cleanupError) {
        message += `\n\nController cleanup also failed: ${errorText(cleanupError)}`;
      }
      await this.reportCiBlock(job, eventKey, message);
      return;
    }
    this.state.setSession(job.issueNumber, result.sessionFile);
    if (isBlockedFinalOutput(result.finalText)) {
      let message = result.finalText;
      try {
        await this.repository.clearAgentChanges(worktree.path, worktree.branch);
      } catch (error) {
        message += `\n\nController cleanup also failed: ${errorText(error)}`;
      }
      await this.reportCiBlock(job, eventKey, message);
      return;
    }

    this.state.setStatus(job.issueNumber, "committing_ci");
    let changed: string[];
    try {
      changed = await this.repository.changedFiles(worktree.path);
      if (changed.length > 0) {
        await this.repository.commitAndPush(worktree.path, worktree.branch, commitMessage(issue, true));
      }
    } catch (error) {
      this.state.setStatus(job.issueNumber, "committing_ci", errorText(error));
      throw error;
    }
    if (changed.length === 0) {
      let message = `Pi made no tracked changes for the failing CI checks.\n\n${result.finalText}`;
      try {
        await this.repository.clearAgentChanges(worktree.path, worktree.branch);
      } catch (error) {
        message += `\n\nController cleanup also failed: ${errorText(error)}`;
      }
      await this.reportCiBlock(job, eventKey, message);
      return;
    }

    await this.github.markPullRequestOpen(job.issueNumber);
    await this.github.commentPullRequest(
      job.prNumber!,
      `🔧 CI repair attempt ${attempt} pushed. I will monitor the new checks automatically.\n\n${markdownSummary(result.finalText)}`,
    );
    this.state.completeEvent(job.issueNumber, eventKey, "pr_open");
  }

  private async reportCiBlock(job: IssueJob, eventKey: string, message: string): Promise<void> {
    const summary = markdownSummary(message);
    if (job.status !== "reporting_ci_pr_comment") {
      this.state.setStatus(job.issueNumber, "reporting_ci_block", summary);
      await this.github.markBlocked(job.issueNumber, summary);
      this.state.setStatus(job.issueNumber, "reporting_ci_pr_comment", summary);
    }
    await this.github.commentPullRequest(
      job.prNumber!,
      `⛔ Automatic CI repair could not continue. Add a new \`/pi retry\` comment after resolving the blocker.\n\n${summary}`,
    );
    this.state.completeEvent(job.issueNumber, eventKey, "pr_open", summary);
  }

  private async processFeedbackJob(job: IssueJob): Promise<void> {
    if (!job.prNumber) return;
    if (!(await this.github.isPullRequestOpen(job.prNumber))) {
      this.state.setStatus(job.issueNumber, "completed");
      return;
    }
    const all = await this.github.listFeedback(job.prNumber);
    const pending = all
      .filter(
        (item) =>
          !this.state.hasProcessed(item.eventKey) &&
          isActionableFeedback(item, this.config.trustedAssociations),
      )
      .slice(0, 20);
    if (pending.length === 0) {
      if (job.status === "addressing_review") this.state.setStatus(job.issueNumber, "pr_open");
      return;
    }
    await this.handleFeedback(job, pending);
  }

  private async handleFeedback(job: IssueJob, feedback: PullRequestFeedback[]): Promise<void> {
    const commands = feedback
      .map((item) => parseWorkerCommand(item.body))
      .filter((command): command is string => command !== null);

    if (commands.some((command) => command === "stop")) {
      this.state.setStatus(job.issueNumber, "stopped");
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      await this.github.commentPullRequest(job.prNumber!, "🛑 Automatic work stopped for this PR.");
      return;
    }

    const onlyCiRetry =
      Boolean(job.ciHeadSha && job.lastError) &&
      feedback.every((item) => item.source === "conversation") &&
      commands.length > 0 &&
      commands.every((command) => command === "retry");
    if (onlyCiRetry) {
      this.state.forgetProcessed(`ci-failure:${job.prNumber}:${job.ciHeadSha}`);
      this.state.resetCiAttempts(job.issueNumber, "");
      this.state.setStatus(job.issueNumber, "pr_open");
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      await this.github.markPullRequestOpen(job.issueNumber);
      await this.github.commentPullRequest(
        job.prNumber!,
        "🔄 CI repair retry queued for the current failed head.",
      );
      return;
    }

    const onlyHelp =
      feedback.every((item) => item.source === "conversation") &&
      commands.every((command) => command === "help");
    if (onlyHelp) {
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      await this.github.commentPullRequest(
        job.prNumber!,
        "Commands: `/pi fix <request>`, `/pi retry`, `/pi verify visual`, `/pi verify gif`, `/pi fix docker <request>` (profile opt-in required), `/pi stop`. Formal reviews and inline review comments from trusted maintainers are handled automatically.",
      );
      return;
    }

    const issue = await this.github.getIssue(job.issueNumber);
    const worktree = await this.repository.ensureIssueWorktree(
      job.issueNumber,
      job.branch,
      job.worktreePath,
    );
    if (
      job.status === "addressing_review" &&
      (await this.repository.hasUnpushedCommits(worktree.path, worktree.branch))
    ) {
      await this.repository.pushIfAhead(worktree.path, worktree.branch);
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      this.state.setStatus(job.issueNumber, "pr_open");
      await this.github.markPullRequestOpen(job.issueNumber);
      await this.github.commentPullRequest(
        job.prNumber!,
        "🔧 Recovered and pushed the interrupted feedback update.",
      );
      return;
    }

    const visualRequested =
      job.visualRequested || commands.some((command) => /\b(?:visual|gif)\b/.test(command));
    const gifRequested = commands.some((command) => /\bgif\b/.test(command));
    const dockerRequested = commands.some((command) => /\bdocker\b/.test(command));
    const evidence = visualRequested
      ? await createEvidenceRun(worktree.path, job.issueNumber, job.prNumber)
      : null;
    this.state.setStatus(job.issueNumber, "addressing_review");
    let controllerPhase = false;

    try {
      const result = await this.agent.run({
        worktree: worktree.path,
        sessionDir: join(this.config.dataDir, "sessions", `issue-${job.issueNumber}`),
        sessionFile: job.sessionFile,
        prompt: buildFeedbackPrompt({
          config: this.config,
          issueNumber: job.issueNumber,
          prNumber: job.prNumber!,
          feedback,
          evidenceDir: evidence?.relativeRunDir ?? null,
          gifRequested,
          dockerAccess: dockerRequested && this.config.allowDocker,
        }),
        logFile: join(this.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
        visualVerification: evidence !== null,
        dockerAccess: dockerRequested,
      });
      this.state.setSession(job.issueNumber, result.sessionFile);
      if (isBlockedFinalOutput(result.finalText)) {
        await this.repository.clearAgentChanges(worktree.path, worktree.branch);
        throw new Error(result.finalText);
      }
      controllerPhase = true;
      const gifCreated = gifRequested ? await finishRequestedGif(evidence?.runDir ?? null) : false;
      const evidenceNote = await visualEvidenceNote(
        evidence?.runDir ?? null,
        evidence?.relativeRunDir ?? null,
      );
      const changed = await this.repository.changedFiles(worktree.path);
      if (changed.length > 0) {
        await this.repository.commitAndPush(
          worktree.path,
          worktree.branch,
          commitMessage(issue, true),
        );
      }
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      this.state.setStatus(job.issueNumber, "pr_open");
      await this.github.markPullRequestOpen(job.issueNumber);
      await this.github.commentPullRequest(
        job.prNumber!,
        `✅ Feedback processed${changed.length > 0 ? " and an update was pushed" : " with no tracked code changes"}.${gifCreated ? ` GIF created at \`${evidence?.relativeRunDir}/workflow.gif\`.` : ""}\n\n${markdownSummary(result.finalText)}${evidenceNote}`,
      );
      await removeExpiredEvidence(worktree.path, this.config.qaRetentionDays);
    } catch (error) {
      const message = `${errorText(error)}${await visualEvidenceNote(
        evidence?.runDir ?? null,
        evidence?.relativeRunDir ?? null,
      )}`;
      if (controllerPhase) {
        this.state.setStatus(job.issueNumber, "addressing_review", message);
        throw error;
      }
      await this.repository.clearAgentChanges(worktree.path, worktree.branch).catch(() => undefined);
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      this.state.setStatus(job.issueNumber, "pr_open", message);
      await this.github.markBlocked(job.issueNumber, message).catch(() => undefined);
      await this.github.commentPullRequest(
        job.prNumber!,
        `⛔ I could not process this feedback. Add a new \`/pi retry\` comment after resolving the blocker.\n\n${message}`,
      );
    }
  }
}
