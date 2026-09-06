import type { DatabaseSync } from "node:sqlite";
import type { EvidenceRunRecord, EvidenceRunStatus } from "../types.js";
import { mapEvidenceRun, type EvidenceRunRow } from "./rows.js";

export class EvidenceStore {
  constructor(private readonly database: DatabaseSync) {}

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
}
