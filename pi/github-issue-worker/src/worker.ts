import { cgroupController, ownCgroupPath } from "./agent/cgroup.js";
import { AppInstanceService } from "./app-instance/index.js";
import { PullRequestWorktreeCleanupService } from "./cleanup.js";
import type { WorkerConfig } from "./config.js";
import { FigmaVerificationService } from "./figma-verification.js";
import { GitHubClient, isActionableFeedback, parseWorkerCommand } from "./github.js";
import { IssuePlanService } from "./issue-plan.js";
import { PiAgentRunner } from "./pi-agent.js";
import { QaVerificationService } from "./qa-verification.js";
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
import { processPlanningIssues } from "./worker/planning-flow.js";
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
      designVerifier?: Pick<FigmaVerificationService, "verify">;
      qaVerifier?: Pick<QaVerificationService, "verify">;
      plans?: Pick<IssuePlanService, "load" | "create">;
      appInstances?: Pick<AppInstanceService, "start">;
    } = {},
  ) {
    const github = dependencies.github ?? new GitHubClient(config);
    const repository = dependencies.repository ?? new RepositoryManager(config);
    // Bash calls and app instances are fenced under the same cgroup root so a call's cleanup never touches the instance.
    const cgroups = cgroupController(ownCgroupPath());
    const agent = dependencies.agent ?? new PiAgentRunner(config, { cgroups });
    this.ctx = {
      config,
      state,
      github,
      repository,
      agent,
      designVerifier: dependencies.designVerifier ?? new FigmaVerificationService(config, agent),
      qaVerifier: dependencies.qaVerifier ?? new QaVerificationService(config, agent),
      plans: dependencies.plans ?? new IssuePlanService(config, agent),
      appInstances: dependencies.appInstances ?? new AppInstanceService(config, cgroups),
    };
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
    const planningIssues = await processPlanningIssues(this.ctx);
    await this.resumeInterruptedIssues();
    await this.processBlockedIssueCommands();
    for (const issue of await this.ctx.github.listReadyIssues()) {
      if (planningIssues.has(issue.number) || issue.labels.some((label) => label.name.toLowerCase() === "pi-plan")) continue;
      const current = this.ctx.state.getJob(issue.number);
      if (current && [
        "claimed", "implementing", "pr_open", "addressing_review", "addressing_ci", "committing_ci",
        "reporting_ci_block", "reporting_ci_pr_comment",
      ].includes(current.status)) continue;
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
      const command = (await this.ctx.github.listIssueCommands(job.issueNumber))
        .filter((item) => item.createdAt > job.updatedAt && !this.ctx.state.hasProcessed(item.eventKey))
        .filter((item) => isActionableFeedback(item, this.ctx.config.trustedAssociations))
        .filter((item) => parseWorkerCommand(item.body) === "retry")
        .at(-1);
      if (!command) continue;
      this.ctx.state.markProcessed(job.issueNumber, command.eventKey);
      if (job.kind === "pull_request" && typeof this.ctx.github.getPullRequest === "function") {
        const pullRequest = await this.ctx.github.getPullRequest(job.prNumber ?? job.issueNumber);
        await startPullRequest(this.ctx, pullRequest).catch((error) => blockInitialIssue(this.ctx, job.issueNumber, error));
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
      if (["addressing_ci", "committing_ci", "reporting_ci_block", "reporting_ci_pr_comment"].includes(job.status) && job.prNumber) {
        await processCiJob(this.ctx, job);
        continue;
      }
      if (job.prNumber || !["claimed", "implementing"].includes(job.status)) continue;
      const issue = await this.ctx.github.getIssue(job.issueNumber);
      await implementIssue(this.ctx, issue, job).catch((error) => handleInitialFailure(this.ctx, job.issueNumber, error));
    }
  }
}
