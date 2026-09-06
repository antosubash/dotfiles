import type { DatabaseSync } from "node:sqlite";
import type {
  EvidenceRunRecord,
  EvidenceRunStatus,
  GitHubIssue,
  GitHubPullRequest,
  IssueJob,
  IssueStatus,
} from "./types.js";
import { EventStore } from "./state/events.js";
import { EvidenceStore } from "./state/evidence-runs.js";
import { JobStore } from "./state/jobs.js";
import { openDatabase } from "./state/schema.js";

export class WorkerState {
  private readonly database: DatabaseSync;
  private readonly jobs: JobStore;
  private readonly evidence: EvidenceStore;
  private readonly events: EventStore;

  constructor(path: string) {
    this.database = openDatabase(path);
    this.jobs = new JobStore(this.database);
    this.evidence = new EvidenceStore(this.database);
    this.events = new EventStore(this.database);
  }

  claim(issue: GitHubIssue, branch: string, worktreePath: string, visualRequested: boolean): IssueJob {
    return this.jobs.claim(issue, branch, worktreePath, visualRequested);
  }

  adoptPullRequest(
    pullRequest: GitHubPullRequest,
    worktreePath: string,
    visualRequested: boolean,
  ): IssueJob {
    return this.jobs.adoptPullRequest(pullRequest, worktreePath, visualRequested);
  }

  getJob(issueNumber: number): IssueJob | null {
    return this.jobs.getJob(issueNumber);
  }

  requireJob(issueNumber: number): IssueJob {
    return this.jobs.requireJob(issueNumber);
  }

  getJobByPullRequest(prNumber: number): IssueJob | null {
    return this.jobs.getJobByPullRequest(prNumber);
  }

  listTrackedPullRequests(): IssueJob[] {
    return this.jobs.listTrackedPullRequests();
  }

  listBlocked(): IssueJob[] {
    return this.jobs.listBlocked();
  }

  listActive(): IssueJob[] {
    return this.jobs.listActive();
  }

  listPullRequests(): IssueJob[] {
    return this.jobs.listPullRequests();
  }

  listReviewJobs(): IssueJob[] {
    return this.jobs.listReviewJobs();
  }

  setStatus(issueNumber: number, status: IssueStatus, error: string | null = null): void {
    return this.jobs.setStatus(issueNumber, status, error);
  }

  requestVisualEvidence(issueNumber: number): void {
    return this.jobs.requestVisualEvidence(issueNumber);
  }

  setSession(issueNumber: number, sessionFile: string): void {
    return this.jobs.setSession(issueNumber, sessionFile);
  }

  setPullRequest(issueNumber: number, prNumber: number, prUrl: string): void {
    return this.jobs.setPullRequest(issueNumber, prNumber, prUrl);
  }

  setCiHead(issueNumber: number, headSha: string): void {
    return this.jobs.setCiHead(issueNumber, headSha);
  }

  recordCiAttempt(issueNumber: number, headSha: string): number {
    return this.jobs.recordCiAttempt(issueNumber, headSha);
  }

  resetCiAttempts(issueNumber: number, headSha: string): void {
    return this.jobs.resetCiAttempts(issueNumber, headSha);
  }

  recordEvidenceRun(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
    status: EvidenceRunStatus = "pending",
    detail: string | null = null,
  ): EvidenceRunRecord {
    return this.evidence.recordEvidenceRun(issueNumber, prNumber, runId, status, detail);
  }

  setEvidenceRunStatus(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
    status: EvidenceRunStatus,
    detail: string | null = null,
  ): EvidenceRunRecord {
    return this.evidence.setEvidenceRunStatus(issueNumber, prNumber, runId, status, detail);
  }

  getEvidenceRun(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
  ): EvidenceRunRecord | null {
    return this.evidence.getEvidenceRun(issueNumber, prNumber, runId);
  }

  requireEvidenceRun(
    issueNumber: number,
    prNumber: number | null,
    runId: string,
  ): EvidenceRunRecord {
    return this.evidence.requireEvidenceRun(issueNumber, prNumber, runId);
  }

  listPublishableEvidence(issueNumber: number, prNumber: number): EvidenceRunRecord[] {
    return this.evidence.listPublishableEvidence(issueNumber, prNumber);
  }

  listEvidenceAwaitingReport(issueNumber: number, prNumber: number): EvidenceRunRecord[] {
    return this.evidence.listEvidenceAwaitingReport(issueNumber, prNumber);
  }

  associatePendingEvidence(issueNumber: number, prNumber: number): void {
    return this.evidence.associatePendingEvidence(issueNumber, prNumber);
  }

  hasProcessed(eventKey: string): boolean {
    return this.events.hasProcessed(eventKey);
  }

  completeEvent(
    issueNumber: number,
    eventKey: string,
    status: IssueStatus,
    error: string | null = null,
  ): void {
    return this.events.completeEvent(issueNumber, eventKey, status, error);
  }

  forgetProcessed(eventKey: string): void {
    return this.events.forgetProcessed(eventKey);
  }

  markProcessed(issueNumber: number, eventKey: string): void {
    return this.events.markProcessed(issueNumber, eventKey);
  }

  close(): void {
    this.database.close();
  }
}
