import { listEvidenceRuns } from "../evidence.js";
import { publishEvidence } from "./evidence-flow.js";
import { errorText, evidenceCommentMarker, type WorkerContext } from "./shared.js";

export async function processPendingEvidencePublications(ctx: WorkerContext): Promise<void> {
  for (const job of ctx.state.listTrackedPullRequests()) {
    if (!job.prNumber) continue;
    const discovered = [
      ...(await listEvidenceRuns(job.worktreePath, job.issueNumber, job.prNumber)),
      ...(await listEvidenceRuns(job.worktreePath, job.issueNumber, null)),
    ];
    for (const evidence of discovered) {
      if (!ctx.state.getEvidenceRun(job.issueNumber, evidence.prNumber, evidence.runId)) {
        ctx.state.recordEvidenceRun(job.issueNumber, evidence.prNumber, evidence.runId);
      }
    }
    ctx.state.associatePendingEvidence(job.issueNumber, job.prNumber);
    const byRunId = new Map(discovered.map((run) => [run.runId, run]));
    for (const record of ctx.state.listEvidenceAwaitingReport(job.issueNumber, job.prNumber)) {
      const eventKey = `evidence:${job.prNumber}:${record.runId}`;
      if (ctx.state.hasProcessed(eventKey)) continue;
      if (record.status === "published") {
        try {
          const marker = evidenceCommentMarker(eventKey);
          if (
            typeof ctx.github.hasPullRequestCommentMarker === "function" &&
            (await ctx.github.hasPullRequestCommentMarker(job.prNumber, marker))
          ) {
            ctx.state.markProcessed(job.issueNumber, eventKey);
            continue;
          }
          await ctx.github.commentPullRequest(
            job.prNumber,
            `${marker}\nRecovered pending QA evidence publication.${record.detail || ""}`,
          );
          ctx.state.markProcessed(job.issueNumber, eventKey);
        } catch (error) {
          ctx.state.recordEvidenceRun(
            job.issueNumber,
            job.prNumber,
            record.runId,
            "published",
            record.detail || `Evidence comment retry pending: ${errorText(error)}`,
          );
        }
        continue;
      }
      const discoveredRun = byRunId.get(record.runId);
      if (!discoveredRun) {
        ctx.state.setEvidenceRunStatus(
          job.issueNumber,
          job.prNumber,
          record.runId,
          "invalid-terminal",
          "Evidence directory is missing",
        );
        continue;
      }
      const evidence = { ...discoveredRun, prNumber: job.prNumber };
      try {
        const published = await publishEvidence(ctx, job.prNumber, job.worktreePath, evidence);
        if (!published) continue;
        await ctx.github.commentPullRequest(
          job.prNumber,
          `${evidenceCommentMarker(published.eventKey)}\nRecovered pending QA evidence publication.${published.note}`,
        );
        ctx.state.markProcessed(job.issueNumber, published.eventKey);
      } catch (error) {
        const current = ctx.state.getEvidenceRun(job.issueNumber, job.prNumber, record.runId);
        if (current && ["pending", "valid"].includes(current.status)) {
          ctx.state.recordEvidenceRun(
            job.issueNumber,
            job.prNumber,
            record.runId,
            current.status,
            `Publication retry pending: ${errorText(error)}`,
          );
        }
      }
    }
  }
}
