import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  EvidenceRunRecord,
  EvidenceRunStatus,
  GitHubIssue,
  GitHubPullRequest,
  IssueJob,
  IssueStatus,
  JobKind,
} from "./types.js";

interface EvidenceRunRow {
  issue_number: number;
  pr_number: number;
  run_id: string;
  status: EvidenceRunStatus;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  issue_number: number;
  job_kind: JobKind;
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

function mapEvidenceRun(row: EvidenceRunRow): EvidenceRunRecord {
  return {
    issueNumber: row.issue_number,
    prNumber: row.pr_number === -1 ? null : row.pr_number,
    runId: row.run_id,
    status: row.status,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row: JobRow): IssueJob {
  return {
    issueNumber: row.issue_number,
    kind: row.job_kind,
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
        job_kind TEXT NOT NULL DEFAULT 'issue' CHECK(job_kind IN ('issue', 'pull_request')),
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
      CREATE TABLE IF NOT EXISTS evidence_runs (
        issue_number INTEGER NOT NULL,
        pr_number INTEGER NOT NULL DEFAULT -1,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(issue_number, pr_number, run_id),
        FOREIGN KEY(issue_number) REFERENCES issue_jobs(issue_number) ON DELETE CASCADE,
        CHECK(pr_number = -1 OR pr_number > 0),
        CHECK(status IN ('pending', 'valid', 'published', 'blocked', 'invalid-terminal'))
      );
    `);
    const jobColumns = new Set(
      (this.database.prepare("PRAGMA table_info(issue_jobs)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!jobColumns.has("job_kind")) {
      this.database.exec("ALTER TABLE issue_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'issue'");
    }
    if (!jobColumns.has("ci_attempts")) {
      this.database.exec("ALTER TABLE issue_jobs ADD COLUMN ci_attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!jobColumns.has("ci_head_sha")) {
      this.database.exec("ALTER TABLE issue_jobs ADD COLUMN ci_head_sha TEXT");
    }
    const duplicatePullRequests = this.database
      .prepare(
        `SELECT pr_number, COUNT(*) AS count FROM issue_jobs
         WHERE pr_number IS NOT NULL GROUP BY pr_number HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ pr_number: number; count: number }>;
    if (duplicatePullRequests.length > 0) {
      throw new Error(
        `State migration blocked by duplicate pull request jobs: ${duplicatePullRequests
          .map((row) => `#${row.pr_number} (${row.count})`)
          .join(", ")}. Stop the worker and reconcile those rows before upgrading.`,
      );
    }
    this.database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS issue_jobs_pr_number ON issue_jobs(pr_number) WHERE pr_number IS NOT NULL",
    );
  }

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

  recordEvidenceRun(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
    status: EvidenceRunStatus = "pending",
    detail: string | null = null,
  ): EvidenceRunRecord {
    if (!/^\d{8}T\d{6}Z$/.test(runId)) throw new Error(`Invalid evidence run id: ${runId}`);
    const normalizedPr = prNumber ?? -1;
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO evidence_runs (
          issue_number, pr_number, run_id, status, detail, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(issue_number, pr_number, run_id) DO UPDATE SET
          status = CASE
            WHEN evidence_runs.status IN ('published', 'blocked', 'invalid-terminal')
              THEN evidence_runs.status
            ELSE excluded.status
          END,
          detail = COALESCE(excluded.detail, evidence_runs.detail),
          updated_at = excluded.updated_at`,
      )
      .run(issueNumber, normalizedPr, runId, status, detail, now, now);
    return this.requireEvidenceRun(issueNumber, prNumber, runId);
  }

  setEvidenceRunStatus(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
    status: EvidenceRunStatus,
    detail: string | null = null,
  ): EvidenceRunRecord {
    const current = this.requireEvidenceRun(issueNumber, prNumber, runId);
    if (["published", "blocked", "invalid-terminal"].includes(current.status) && current.status !== status) {
      return current;
    }
    this.database
      .prepare(
        `UPDATE evidence_runs SET status = ?, detail = ?, updated_at = ?
         WHERE issue_number = ? AND pr_number = ? AND run_id = ?`,
      )
      .run(status, detail, new Date().toISOString(), issueNumber, prNumber ?? -1, runId);
    return this.requireEvidenceRun(issueNumber, prNumber, runId);
  }

  getEvidenceRun(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
  ): EvidenceRunRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM evidence_runs
         WHERE issue_number = ? AND pr_number = ? AND run_id = ?`,
      )
      .get(issueNumber, prNumber ?? -1, runId) as EvidenceRunRow | undefined;
    return row ? mapEvidenceRun(row) : null;
  }

  requireEvidenceRun(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
  ): EvidenceRunRecord {
    const run = this.getEvidenceRun(issueNumber, prNumber, runId);
    if (!run) throw new Error(`No evidence state found for issue #${issueNumber}, run ${runId}`);
    return run;
  }

  listPublishableEvidence(issueNumber: number, prNumber: number): EvidenceRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM evidence_runs
         WHERE issue_number = ? AND pr_number = ? AND status IN ('pending', 'valid')
         ORDER BY run_id`,
      )
      .all(issueNumber, prNumber) as unknown as EvidenceRunRow[];
    return rows.map(mapEvidenceRun);
  }

  listEvidenceAwaitingReport(issueNumber: number, prNumber: number): EvidenceRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM evidence_runs
         WHERE issue_number = ? AND pr_number = ? AND status IN ('pending', 'valid', 'published')
         ORDER BY run_id`,
      )
      .all(issueNumber, prNumber) as unknown as EvidenceRunRow[];
    return rows.map(mapEvidenceRun);
  }

  associatePendingEvidence(issueNumber: number, prNumber: number): void {
    const pending = this.database
      .prepare("SELECT * FROM evidence_runs WHERE issue_number = ? AND pr_number = -1 ORDER BY run_id")
      .all(issueNumber) as unknown as EvidenceRunRow[];
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of pending) {
        this.database
          .prepare(
            `INSERT OR IGNORE INTO evidence_runs (
              issue_number, pr_number, run_id, status, detail, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(issueNumber, prNumber, row.run_id, row.status, row.detail, row.created_at, now);
      }
      this.database
        .prepare("DELETE FROM evidence_runs WHERE issue_number = ? AND pr_number = -1")
        .run(issueNumber);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
