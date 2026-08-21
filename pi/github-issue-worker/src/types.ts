export type IssueStatus =
  | "claimed"
  | "implementing"
  | "pr_open"
  | "addressing_review"
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
  title: string;
  status: IssueStatus;
  branch: string;
  worktreePath: string;
  sessionFile: string | null;
  prNumber: number | null;
  prUrl: string | null;
  visualRequested: boolean;
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

export interface AgentRunResult {
  sessionFile: string;
  finalText: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
