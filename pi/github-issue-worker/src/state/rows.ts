import type {
  EvidenceRunRecord,
  EvidenceRunStatus,
  IssueJob,
  IssueStatus,
  JobKind,
} from "../types.js";

export interface EvidenceRunRow {
  issue_number: number;
  pr_number: number;
  run_id: string;
  status: EvidenceRunStatus;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
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

export function mapEvidenceRun(row: EvidenceRunRow): EvidenceRunRecord {
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

export function mapJob(row: JobRow): IssueJob {
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
