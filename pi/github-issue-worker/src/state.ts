import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GitHubIssue, IssueJob, IssueStatus } from "./types.js";

interface JobRow {
  issue_number: number;
  title: string;
  status: IssueStatus;
  branch: string;
  worktree_path: string;
  session_file: string | null;
  pr_number: number | null;
  pr_url: string | null;
  visual_requested: number;
  ci_attempts: number;
  ci_head_sha: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapJob(row: JobRow): IssueJob {
  return {
    issueNumber: row.issue_number,
    title: row.title,
    status: row.status,
    branch: row.branch,
    worktreePath: row.worktree_path,
    sessionFile: row.session_file,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    visualRequested: row.visual_requested === 1,
    ciAttempts: row.ci_attempts,
    ciHeadSha: row.ci_head_sha,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkerState {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS issue_jobs (
        issue_number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        session_file TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        visual_requested INTEGER NOT NULL DEFAULT 0,
        ci_attempts INTEGER NOT NULL DEFAULT 0,
        ci_head_sha TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_key TEXT PRIMARY KEY,
        issue_number INTEGER NOT NULL,
        processed_at TEXT NOT NULL,
        FOREIGN KEY(issue_number) REFERENCES issue_jobs(issue_number) ON DELETE CASCADE
      );
    `);
    const jobColumns = new Set(
      (this.database.prepare("PRAGMA table_info(issue_jobs)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!jobColumns.has("ci_attempts")) {
      this.database.exec("ALTER TABLE issue_jobs ADD COLUMN ci_attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!jobColumns.has("ci_head_sha")) {
      this.database.exec("ALTER TABLE issue_jobs ADD COLUMN ci_head_sha TEXT");
    }
  }

  claim(issue: GitHubIssue, branch: string, worktreePath: string, visualRequested: boolean): IssueJob {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO issue_jobs (
          issue_number, title, status, branch, worktree_path, visual_requested, created_at, updated_at
        ) VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?)
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

  hasProcessed(eventKey: string): boolean {
    return Boolean(
      this.database.prepare("SELECT 1 FROM processed_events WHERE event_key = ?").get(eventKey),
    );
  }

  completeEvent(
    issueNumber: number,
    eventKey: string,
    status: IssueStatus,
    error: string | null = null,
  ): void {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "INSERT OR IGNORE INTO processed_events(event_key, issue_number, processed_at) VALUES (?, ?, ?)",
        )
        .run(eventKey, issueNumber, now);
      this.database
        .prepare(
          "UPDATE issue_jobs SET status = ?, last_error = ?, updated_at = ? WHERE issue_number = ?",
        )
        .run(status, error, now, issueNumber);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  forgetProcessed(eventKey: string): void {
    this.database.prepare("DELETE FROM processed_events WHERE event_key = ?").run(eventKey);
  }

  markProcessed(issueNumber: number, eventKey: string): void {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO processed_events (event_key, issue_number, processed_at) VALUES (?, ?, ?)",
      )
      .run(eventKey, issueNumber, new Date().toISOString());
  }

  close(): void {
    this.database.close();
  }
}
