import type { GitHubIssue, IssueJob } from "../types.js";
import type { WorkerContext } from "./shared.js";

/** Run fresh acceptance and design verification before every controller mutation. */
export async function verifyImplementation(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: string,
  issue?: GitHubIssue,
): Promise<string> {
  const original = issue ?? await ctx.github.getIssue(job.issueNumber);
  const plan = await ctx.plans.load(original);
  const qaReport = await ctx.qaVerifier.verify(original, worktree, plan);
  const designReport = await ctx.designVerifier.verify(original, worktree, plan);
  return `\n\nIndependent QA passed. Local report: \`${qaReport}\`.` +
    (designReport ? `\nIndependent Figma design verification passed. Local private report: \`${designReport}\`.` : "");
}
