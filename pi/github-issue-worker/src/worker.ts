import { PullRequestWorktreeCleanupService } from "./cleanup.js";
import type { WorkerConfig } from "./config.js";
import { GitHubClient, isActionableFeedback, parseWorkerCommand } from "./github.js";
import { PiAgentRunner } from "./pi-agent.js";
import { RepositoryManager } from "./repository.js";
import { WorkerState } from "./state.js";
import { processPullRequestCi, processCiJob } from "./worker/ci-flow.js";
import { processPullRequestConflicts } from "./worker/conflict-flow.js";
import { processPendingEvidencePublications } from "./worker/evidence-recovery.js";
import { processFeedbackJob, processPullRequestFeedback } from "./worker/feedback-flow.js";
import {
  blockInitialIssue,
  handleInitialFailure,
  implementIssue,
  processPendingPullRequestLabels,
  startIssue,
} from "./worker/issue-flow.js";
import { processReadyPullRequests, startPullRequest } from "./worker/pull-request-adoption.js";
import type { WorkerContext } from "./worker/shared.js";

export { isBlockedFinalOutput } from "./worker/shared.js";

export class IssueWorker {
  private readonly ctx: WorkerContext;
  private readonly cleanup: PullRequestWorktreeCleanupService;

  constructor(
    config: WorkerConfig,
    state: WorkerState,
    dependencies: {
      github?: GitHubClient;
      repository?: RepositoryManager;
      agent?: PiAgentRunner;
    } = {},
  ) {
    const github = dependencies.github ?? new GitHubClient(config);
    const repository = dependencies.repository ?? new RepositoryManager(config);
    const agent = dependencies.agent ?? new PiAgentRunner(config);
    this.ctx = { config, state, github, repository, agent };
    this.cleanup = new PullRequestWorktreeCleanupService(state, github, repository);
  }

  async check(): Promise<void> {
    await this.ctx.github.assertAuthenticated();
    await this.ctx.agent.assertAvailable();
  }

  async initialize(): Promise<void> {
    await this.check();
    await this.ctx.github.ensureLabels();
    await this.ctx.repository.ensureControlRepository();
  }

  async tick(): Promise<void> {
    await this.resumeInterruptedIssues();
    await this.processBlockedIssueCommands();
    const readyIssues = await this.ctx.github.listReadyIssues();
    for (const issue of readyIssues) {
      const current = this.ctx.state.getJob(issue.number);
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
      await startIssue(this.ctx, issue).catch((error) => handleInitialFailure(this.ctx, issue.number, error));
    }
    await processReadyPullRequests(this.ctx);
    await processPendingPullRequestLabels(this.ctx);
    await processPendingEvidencePublications(this.ctx);
    await this.cleanup.run();
    if (await processPullRequestConflicts(this.ctx)) return;
    await processPullRequestFeedback(this.ctx);
    await processPullRequestCi(this.ctx);
  }

  private async processBlockedIssueCommands(): Promise<void> {
    if (typeof this.ctx.github.listIssueCommands !== "function") return;
    for (const job of this.ctx.state.listBlocked()) {
      const commands = (await this.ctx.github.listIssueCommands(job.issueNumber))
        .filter(
          (item) =>
            item.createdAt > job.updatedAt &&
            !this.ctx.state.hasProcessed(item.eventKey) &&
            isActionableFeedback(item, this.ctx.config.trustedAssociations),
        )
        .filter((item) => parseWorkerCommand(item.body) === "retry");
      const command = commands.at(-1);
      if (!command) continue;
      this.ctx.state.markProcessed(job.issueNumber, command.eventKey);
      if (job.kind === "pull_request" && typeof this.ctx.github.getPullRequest === "function") {
        const pullRequest = await this.ctx.github.getPullRequest(job.prNumber ?? job.issueNumber);
        await startPullRequest(this.ctx, pullRequest).catch((error) =>
          blockInitialIssue(this.ctx, job.issueNumber, error),
        );
      } else {
        const issue = await this.ctx.github.getIssue(job.issueNumber);
        await startIssue(this.ctx, issue).catch((error) => handleInitialFailure(this.ctx, issue.number, error));
      }
    }
  }

  private async resumeInterruptedIssues(): Promise<void> {
    for (const job of this.ctx.state.listActive()) {
      if (job.status === "addressing_review" && job.prNumber) {
        await processFeedbackJob(this.ctx, job);
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
        await processCiJob(this.ctx, job);
        continue;
      }
      if (job.prNumber || !["claimed", "implementing"].includes(job.status)) continue;
      const issue = await this.ctx.github.getIssue(job.issueNumber);
      await implementIssue(this.ctx, issue, job).catch((error) =>
        handleInitialFailure(this.ctx, job.issueNumber, error),
      );
    }
  }
}
