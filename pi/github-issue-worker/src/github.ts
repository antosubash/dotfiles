import type { WorkerConfig } from "./config.js";
import type { EvidenceAttachment } from "./evidence.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  PullRequestCheckFailure,
  PullRequestChecks,
  PullRequestFeedback,
  PullRequestInfo,
  PullRequestLifecycle,
  PullRequestMergeState,
} from "./types.js";
import { createGhRunner, type GhRunner } from "./github/gh.js";
import * as checks from "./github/checks.js";
import * as comments from "./github/comments.js";
import * as evidenceBranch from "./github/evidence-branch.js";
import * as labels from "./github/labels.js";
import * as queries from "./github/queries.js";

export {
  classifyPullRequestChecks,
  ciFailureDisposition,
  extractFailureExcerpt,
  type CiFailureDisposition,
} from "./github/checks.js";
export { isActionableFeedback, parseWorkerCommand } from "./github/comments.js";

export class GitHubClient {
  private readonly gh: GhRunner;

  constructor(
    private readonly config: WorkerConfig,
    ghRunner?: GhRunner,
  ) {
    this.gh = ghRunner ?? createGhRunner();
  }

  async assertAuthenticated(): Promise<void> {
    await this.gh(["auth", "status", "--hostname", "github.com"]);
  }

  publishEvidence(
    prNumber: number,
    headSha: string,
    runId: string,
    attachments: readonly EvidenceAttachment[],
  ): Promise<string> {
    return evidenceBranch.publishEvidence(this.gh, this.config, prNumber, headSha, runId, attachments);
  }

  ensureLabels(): Promise<void> {
    return labels.ensureLabels(this.gh, this.config);
  }

  listReadyIssues(): Promise<GitHubIssue[]> {
    return queries.listReadyIssues(this.gh, this.config);
  }

  listReadyPullRequests(): Promise<GitHubPullRequest[]> {
    return queries.listReadyPullRequests(this.gh, this.config);
  }

  getPullRequest(prNumber: number): Promise<GitHubPullRequest> {
    return queries.getPullRequest(this.gh, this.config, prNumber);
  }

  getIssue(issueNumber: number): Promise<GitHubIssue> {
    return queries.getIssue(this.gh, this.config, issueNumber);
  }

  claimIssue(issueNumber: number): Promise<void> {
    return labels.claimIssue(this.gh, this.config, issueNumber);
  }

  claimPullRequest(pullRequest: GitHubPullRequest): Promise<void> {
    return labels.claimPullRequest(this.gh, this.config, pullRequest);
  }

  activatePullRequest(prNumber: number): Promise<void> {
    return labels.activatePullRequest(this.gh, this.config, prNumber);
  }

  markBlocked(issueNumber: number, message: string): Promise<void> {
    return labels.markBlocked(this.gh, this.config, issueNumber, message);
  }

  markPullRequestOpen(issueNumber: number): Promise<void> {
    return labels.markPullRequestOpen(this.gh, this.config, issueNumber);
  }

  commentIssue(issueNumber: number, body: string): Promise<void> {
    return comments.commentIssue(this.gh, this.config, issueNumber, body);
  }

  commentPullRequest(prNumber: number, body: string): Promise<void> {
    return comments.commentPullRequest(this.gh, this.config, prNumber, body);
  }

  hasPullRequestCommentMarker(prNumber: number, marker: string): Promise<boolean> {
    return comments.hasPullRequestCommentMarker(this.gh, this.config, prNumber, marker);
  }

  findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    return queries.findOpenPullRequest(this.gh, this.config, branch);
  }

  findOpenPullRequestsForIssue(
    issueNumber: number,
    excludedBranch: string,
  ): Promise<PullRequestInfo[]> {
    return queries.findOpenPullRequestsForIssue(this.gh, this.config, issueNumber, excludedBranch);
  }

  labelPullRequestFromIssue(prNumber: number, issue: GitHubIssue): Promise<void> {
    return labels.labelPullRequestFromIssue(this.gh, this.config, prNumber, issue);
  }

  createDraftPullRequest(branch: string, title: string, body: string): Promise<PullRequestInfo> {
    return queries.createDraftPullRequest(this.gh, this.config, branch, title, body);
  }

  isPullRequestOpen(prNumber: number): Promise<boolean> {
    return queries.isPullRequestOpen(this.gh, this.config, prNumber);
  }

  getPullRequestLifecycle(prNumber: number): Promise<PullRequestLifecycle> {
    return queries.getPullRequestLifecycle(this.gh, this.config, prNumber);
  }

  getPullRequestMergeState(prNumber: number): Promise<PullRequestMergeState> {
    return queries.getPullRequestMergeState(this.gh, this.config, prNumber);
  }

  rerunFailedWorkflowRuns(failures: readonly PullRequestCheckFailure[]): Promise<number> {
    return checks.rerunFailedWorkflowRuns(this.gh, this.config, failures);
  }

  getPullRequestChecks(prNumber: number, includeFailureLogs = false): Promise<PullRequestChecks> {
    return checks.getPullRequestChecks(this.gh, this.config, prNumber, includeFailureLogs);
  }

  listIssueCommands(issueNumber: number): Promise<PullRequestFeedback[]> {
    return comments.listIssueCommands(this.gh, this.config, issueNumber);
  }

  listFeedback(prNumber: number): Promise<PullRequestFeedback[]> {
    return comments.listFeedback(this.gh, this.config, prNumber);
  }
}
