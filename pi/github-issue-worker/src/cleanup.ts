import type { GitHubClient } from "./github.js";
import type { RepositoryManager } from "./repository.js";
import type { WorkerState } from "./state.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PullRequestWorktreeCleanupService {
  constructor(
    private readonly state: WorkerState,
    private readonly github: GitHubClient,
    private readonly repository: RepositoryManager,
  ) {}

  async run(): Promise<void> {
    if (
      typeof this.github.getPullRequestLifecycle !== "function" ||
      typeof this.repository.removeManagedWorktree !== "function"
    ) {
      return;
    }
    for (const job of this.state.listTrackedPullRequests()) {
      if (!job.prNumber) continue;
      let merged = false;
      try {
        const lifecycle = await this.github.getPullRequestLifecycle(job.prNumber);
        merged = lifecycle.state === "MERGED" || lifecycle.mergedAt !== null;
        if (!merged) continue;
        const awaitingEvidence = this.state.listEvidenceAwaitingReport(
          job.issueNumber,
          job.prNumber,
        );
        if (
          awaitingEvidence.some(
            (record) =>
              !this.state.hasProcessed(`evidence:${job.prNumber}:${record.runId}`),
          )
        ) {
          continue;
        }
        const eventKey = `worktree-cleanup:${job.prNumber}:${lifecycle.headSha}`;
        if (this.state.hasProcessed(eventKey)) continue;
        await this.repository.removeManagedWorktree(
          job.kind,
          job.issueNumber,
          job.worktreePath,
          job.branch,
          lifecycle.headSha,
        );
        this.state.completeEvent(job.issueNumber, eventKey, "completed");
      } catch (error) {
        if (merged) {
          this.state.setStatus(
            job.issueNumber,
            "completed",
            `Merged pull request worktree cleanup pending: ${errorText(error)}`,
          );
        } else {
          console.error(`Pull request #${job.prNumber} cleanup check failed`, error);
        }
      }
    }
  }
}
