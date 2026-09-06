import type { DatabaseSync } from "node:sqlite";
import type { IssueStatus } from "../types.js";

export class EventStore {
  constructor(private readonly database: DatabaseSync) {}

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
}
