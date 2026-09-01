export type JobKind = "issue" | "pull_request";

export type IssueStatus =
  | "claimed"
  | "implementing"
  | "pr_open"
  | "addressing_review"
  | "addressing_ci"
  | "committing_ci"
  | "reporting_ci_block"
  | "reporting_ci_pr_comment"
  | "blocked"
  | "stopped"
  | "completed";

export interface Label {
  name: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  labels: Label[];
  author: { login: string };
}

export interface IssueJob {
  issueNumber: number;
  kind: JobKind;
  title: string;
  status: IssueStatus;
  branch: string;
  worktreePath: string;
  sessionFile: string | null;
  prNumber: number | null;
  prUrl: string | null;
  visualRequested: boolean;
  ciAttempts: number;
  ciHeadSha: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FeedbackSource = "conversation" | "review" | "review_comment";

export interface PullRequestFeedback {
  eventKey: string;
  source: FeedbackSource;
  id: number;
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
  url: string | null;
}

export interface PullRequestInfo {
  number: number;
  url: string;
}

export interface GitHubPullRequest extends GitHubIssue {
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

export interface PullRequestLifecycle {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  headSha: string;
}

export interface PullRequestMergeState {
  headSha: string;
  baseSha: string;
  baseBranch: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
}

export interface PullRequestCheckFailure {
  name: string;
  conclusion: string;
  detailsUrl: string | null;
  excerpt: string | null;
}

export interface PullRequestChecks {
  headSha: string;
  state: "none" | "pending" | "passed" | "failed";
  failures: PullRequestCheckFailure[];
}

export type EvidenceRunStatus =
  | "pending"
  | "valid"
  | "published"
  | "blocked"
  | "invalid-terminal";

export interface EvidenceRunRecord {
  issueNumber: number;
  prNumber: number | null;
  runId: string;
  status: EvidenceRunStatus;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunResult {
  sessionFile: string;
  finalText: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
