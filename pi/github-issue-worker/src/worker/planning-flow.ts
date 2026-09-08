import { errorText, type WorkerContext } from "./shared.js";

/** Process pi-plan requests before ready work; planning never commits, pushes, or opens a PR. */
export async function processPlanningIssues(ctx: WorkerContext): Promise<Set<number>> {
  const handled = new Set<number>();
  if (typeof ctx.github.listPlanningIssues !== "function") return handled;
  for (const issue of await ctx.github.listPlanningIssues()) {
    handled.add(issue.number);
    try {
      const job = ctx.state.getJob(issue.number);
      if (job && !["blocked", "stopped", "completed"].includes(job.status)) {
        ctx.state.setStatus(
          job.issueNumber,
          "stopped",
          "pi-plan requested on an active job; paused without changing source.",
        );
        throw new Error(
          "pi-plan is plan-only. The active job is now paused; inspect its worktree, then request pi-plan again.",
        );
      }
      const branch = ctx.repository.branchForIssue(issue.number, issue.title);
      const worktree = await ctx.repository.ensureIssueWorktree(
        issue.number,
        branch,
        ctx.repository.pathForIssue(issue.number),
      );
      const plan = await ctx.plans.create(issue, worktree.path);
      await ctx.github.finishPlanning(
        issue.number,
        `## pi-plan — ready for review\n\nNo implementation, commit, push, or PR was performed. Add \`${ctx.config.readyLabel}\` after reviewing this plan.\n\n${JSON.stringify(plan, null, 2)}`,
      );
    } catch (error) {
      await ctx.github.finishPlanning(
        issue.number,
        `⛔ pi-plan blocked. No implementation was started. Fix the blocker and add \`pi-plan\` again.\n\n${errorText(error)}`,
      );
    }
  }
  return handled;
}
