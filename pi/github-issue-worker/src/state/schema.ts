import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  database.exec(`
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
    (database.prepare("PRAGMA table_info(issue_jobs)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!jobColumns.has("job_kind")) {
    database.exec("ALTER TABLE issue_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'issue'");
  }
  if (!jobColumns.has("ci_attempts")) {
    database.exec("ALTER TABLE issue_jobs ADD COLUMN ci_attempts INTEGER NOT NULL DEFAULT 0");
  }
  if (!jobColumns.has("ci_head_sha")) {
    database.exec("ALTER TABLE issue_jobs ADD COLUMN ci_head_sha TEXT");
  }
  const duplicatePullRequests = database
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
  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS issue_jobs_pr_number ON issue_jobs(pr_number) WHERE pr_number IS NOT NULL",
  );
  return database;
}
