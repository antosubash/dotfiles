import type { DatabaseSync } from "node:sqlite";
import type { GitHubIssue, GitHubPullRequest, IssueJob, IssueStatus } from "../types.js";
import { mapJob, type JobRow } from "./rows.js";

export class JobStore {
  constructor(private readonly database: DatabaseSync) {}

  claim(issue: GitHubIssue, branch: string, worktreePath: string, visualRequested: boolean): IssueJob {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO issue_jobs (
          issue_number, job_kind, title, status, branch, worktree_path, visual_requested, created_at, updated_at
        ) VALUES (?, 'issue', ?, 'claimed', ?, ?, ?, ?, ?)
        ON CONFLICT(issue_number) DO UPDATE SET
          title = excluded.title,
          status = 'claimed',
          visual_requested = MAX(issue_jobs.visual_requested, excluded.visual_requested),
          ci_attempts = 0,
          ci_head_sha = NULL,
          last_error = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(issue.number, issue.title, branch, worktreePath, visualRequested ? 1 : 0, now, now);
    return this.requireJob(issue.number);
  }

  adoptPullRequest(
    pullRequest: GitHubPullRequest,
    worktreePath: string,
    visualRequested: boolean,
  ): IssueJob {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO issue_jobs (
          issue_number, job_kind, title, status, branch, worktree_path, pr_number, pr_url,
          visual_requested, created_at, updated_at
        ) VALUES (?, 'pull_request', ?, 'pr_open', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(issue_number) DO UPDATE SET
          title = excluded.title,
          status = 'pr_open',
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          pr_number = excluded.pr_number,
          pr_url = excluded.pr_url,
          visual_requested = MAX(issue_jobs.visual_requested, excluded.visual_requested),
          ci_attempts = 0,
          ci_head_sha = NULL,
          last_error = NULL,
          updated_at = excluded.updated_at
        WHERE issue_jobs.job_kind = 'pull_request' AND issue_jobs.pr_number = excluded.pr_number`,
      )
      .run(
        pullRequest.number,
        pullRequest.title,
        pullRequest.headRefName,
        worktreePath,
        pullRequest.number,
        pullRequest.url,
        visualRequested ? 1 : 0,
        now,
        now,
      );
    const job = this.requireJob(pullRequest.number);
    if (job.kind !== "pull_request" || job.prNumber !== pullRequest.number) {
      throw new Error(`Pull request #${pullRequest.number} collides with an existing issue job`);
    }
    return job;
  }

  getJob(issueNumber: number): IssueJob | null {
    const row = this.database
      .prepare("SELECT * FROM issue_jobs WHERE issue_number = ?")
      .get(issueNumber) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  requireJob(issueNumber: number): IssueJob {
    const job = this.getJob(issueNumber);
    if (!job) throw new Error(`No state found for issue #${issueNumber}`);
    return job;
  }

  getJobByPullRequest(prNumber: number): IssueJob | null {
    const row = this.database
      .prepare("SELECT * FROM issue_jobs WHERE pr_number = ?")
      .get(prNumber) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  listTrackedPullRequests(): IssueJob[] {
    const rows = this.database
      .prepare("SELECT * FROM issue_jobs WHERE pr_number IS NOT NULL ORDER BY issue_number")
      .all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  listBlocked(): IssueJob[] {
    const rows = this.database
      .prepare("SELECT * FROM issue_jobs WHERE status = 'blocked' ORDER BY issue_number")
      .all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  listActive(): IssueJob[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM issue_jobs
         WHERE status IN ('claimed', 'implementing', 'pr_open', 'addressing_review', 'addressing_ci', 'committing_ci', 'reporting_ci_block', 'reporting_ci_pr_comment')
         ORDER BY issue_number`,
      )
      .all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  listPullRequests(): IssueJob[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM issue_jobs
         WHERE status = 'pr_open' AND pr_number IS NOT NULL
         ORDER BY issue_number`,
      )
      .all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  listReviewJobs(): IssueJob[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM issue_jobs
         WHERE status IN ('pr_open', 'addressing_review', 'addressing_ci', 'committing_ci', 'reporting_ci_block', 'reporting_ci_pr_comment') AND pr_number IS NOT NULL
         ORDER BY issue_number`,
      )
      .all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  setStatus(issueNumber: number, status: IssueStatus, error: string | null = null): void {
    this.database
      .prepare("UPDATE issue_jobs SET status = ?, last_error = ?, updated_at = ? WHERE issue_number = ?")
      .run(status, error, new Date().toISOString(), issueNumber);
  }

  requestVisualEvidence(issueNumber: number): void {
    this.database
      .prepare("UPDATE issue_jobs SET visual_requested = 1, updated_at = ? WHERE issue_number = ?")
      .run(new Date().toISOString(), issueNumber);
  }

  setSession(issueNumber: number, sessionFile: string): void {
    this.database
      .prepare("UPDATE issue_jobs SET session_file = ?, updated_at = ? WHERE issue_number = ?")
      .run(sessionFile, new Date().toISOString(), issueNumber);
  }

  setPullRequest(issueNumber: number, prNumber: number, prUrl: string): void {
    this.database
      .prepare(
        `UPDATE issue_jobs
         SET pr_number = ?, pr_url = ?, status = 'pr_open', last_error = NULL, updated_at = ?
         WHERE issue_number = ?`,
      )
      .run(prNumber, prUrl, new Date().toISOString(), issueNumber);
  }

  setCiHead(issueNumber: number, headSha: string): void {
    this.database
      .prepare("UPDATE issue_jobs SET ci_head_sha = ?, updated_at = ? WHERE issue_number = ?")
      .run(headSha, new Date().toISOString(), issueNumber);
  }

  recordCiAttempt(issueNumber: number, headSha: string): number {
    const current = this.requireJob(issueNumber);
    if (current.ciHeadSha === headSha && current.ciAttempts > 0) return current.ciAttempts;
    this.database
      .prepare(
        `UPDATE issue_jobs
         SET ci_attempts = ci_attempts + 1, ci_head_sha = ?, updated_at = ?
         WHERE issue_number = ?`,
      )
      .run(headSha, new Date().toISOString(), issueNumber);
    return this.requireJob(issueNumber).ciAttempts;
  }

  resetCiAttempts(issueNumber: number, headSha: string): void {
    this.database
      .prepare(
        `UPDATE issue_jobs
         SET ci_attempts = 0, ci_head_sha = ?, last_error = NULL, updated_at = ?
         WHERE issue_number = ?`,
      )
      .run(headSha, new Date().toISOString(), issueNumber);
  }
}
