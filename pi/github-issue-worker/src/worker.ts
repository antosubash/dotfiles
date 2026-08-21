import { access } from "node:fs/promises";
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
  buildFeedbackPrompt,
  buildIssuePrompt,
  commitMessage,
  pullRequestBody,
  pullRequestTitle,
} from "./prompts.js";
import { RepositoryManager } from "./repository.js";
import { WorkerState } from "./state.js";
import type { GitHubIssue, IssueJob, PullRequestFeedback } from "./types.js";

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message;
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

function markdownSummary(text: string, maximum = 5_000): string {
  if (!text) return "Pi returned no textual summary.";
  return text.length > maximum ? `${text.slice(0, maximum)}\n\n…truncated` : text;
}

export function isBlockedFinalOutput(text: string): boolean {
  return /^\s*BLOCKED\b/im.test(text);
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
      if (current && ["claimed", "implementing", "pr_open", "addressing_review"].includes(current.status)) {
        continue;
      }
      await this.startIssue(issue).catch((error) => this.blockInitialIssue(issue.number, error));
    }
    await this.processPullRequestFeedback();
  }

  private async resumeInterruptedIssues(): Promise<void> {
    for (const job of this.state.listActive()) {
      if (job.status === "addressing_review" && job.prNumber) {
        await this.processFeedbackJob(job);
        continue;
      }
      if (job.prNumber || !["claimed", "implementing"].includes(job.status)) continue;
      const issue = await this.github.getIssue(job.issueNumber);
      await this.implementIssue(issue, job).catch((error) => this.blockInitialIssue(job.issueNumber, error));
    }
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
      const result = await this.agent.run({
        worktree: worktree.path,
        sessionDir,
        sessionFile: job.sessionFile,
        prompt: buildIssuePrompt({
          config: this.config,
          issue,
          evidenceDir: evidence?.relativeRunDir ?? null,
        }),
        logFile,
      });
      this.state.setSession(issue.number, result.sessionFile);
      finalText = result.finalText;
      if (isBlockedFinalOutput(finalText)) throw new Error(finalText);
    }

    const changedFiles = await this.repository.changedFiles(worktree.path);
    if (changedFiles.length > 0) {
      await this.repository.commitAndPush(
        worktree.path,
        worktree.branch,
        commitMessage(issue),
      );
    } else if (await this.repository.hasCommitsAhead(worktree.path)) {
      await this.repository.pushIfAhead(worktree.path, worktree.branch);
    } else if (isBlockedFinalOutput(finalText)) {
      throw new Error(finalText);
    } else {
      throw new Error(`Pi made no tracked changes.\n\n${finalText}`);
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
    await this.github.commentIssue(
      issue.number,
      `✅ Draft pull request opened: ${pull.url}\n\n${markdownSummary(finalText, 2_500)}`,
    );
    await removeExpiredEvidence(worktree.path, this.config.qaRetentionDays);
  }

  private async blockInitialIssue(issueNumber: number, error: unknown): Promise<void> {
    const message = errorText(error);
    this.state.setStatus(issueNumber, "blocked", message);
    await this.github.markBlocked(issueNumber, message).catch(() => undefined);
  }

  private async processPullRequestFeedback(): Promise<void> {
    for (const job of this.state.listReviewJobs()) await this.processFeedbackJob(job);
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

    const onlyHelp =
      feedback.every((item) => item.source === "conversation") &&
      commands.every((command) => command === "help");
    if (onlyHelp) {
      for (const item of feedback) this.state.markProcessed(job.issueNumber, item.eventKey);
      await this.github.commentPullRequest(
        job.prNumber!,
        "Commands: `/pi fix <request>`, `/pi retry`, `/pi verify visual`, `/pi verify gif`, `/pi stop`. Formal reviews and inline review comments from trusted maintainers are handled automatically.",
      );
      return;
    }

    const issue = await this.github.getIssue(job.issueNumber);
    const worktree = await this.repository.ensureIssueWorktree(
      job.issueNumber,
      job.branch,
      job.worktreePath,
    );
    const visualRequested =
      job.visualRequested || commands.some((command) => command.startsWith("verify"));
    const gifRequested = commands.some((command) => command.includes("gif"));
    const evidence = visualRequested
      ? await createEvidenceRun(worktree.path, job.issueNumber, job.prNumber)
      : null;
    this.state.setStatus(job.issueNumber, "addressing_review");

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
        }),
        logFile: join(this.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
      });
      this.state.setSession(job.issueNumber, result.sessionFile);
      if (isBlockedFinalOutput(result.finalText)) throw new Error(result.finalText);
      const gifCreated = gifRequested ? await finishRequestedGif(evidence?.runDir ?? null) : false;
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
        `✅ Feedback processed${changed.length > 0 ? " and an update was pushed" : " with no tracked code changes"}.${gifCreated ? ` GIF created at \`${evidence?.relativeRunDir}/workflow.gif\`.` : ""}\n\n${markdownSummary(result.finalText)}`,
      );
      await removeExpiredEvidence(worktree.path, this.config.qaRetentionDays);
    } catch (error) {
      const message = errorText(error);
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
