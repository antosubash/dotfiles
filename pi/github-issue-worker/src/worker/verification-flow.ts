import type { AppInstance } from "../app-instance/index.js";
import type { GitHubIssue, IssueJob } from "../types.js";
import type { WorkerContext } from "./shared.js";

/** Run fresh acceptance and design verification before every controller mutation. */
export async function verifyImplementation(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: string,
  issue?: GitHubIssue,
  instance: AppInstance | null = null,
): Promise<string> {
  const original = issue ?? await ctx.github.getIssue(job.issueNumber);
  const plan = await ctx.plans.load(original);
  await instance?.ensureCurrent();
  const qaReport = await ctx.qaVerifier.verify(original, worktree, plan, { instance });
  const designReport = await ctx.designVerifier.verify(original, worktree, plan);
  return `\n\nIndependent QA passed. Local report: \`${qaReport}\`.` +
    (designReport ? `\nIndependent Figma design verification passed. Local private report: \`${designReport}\`.` : "");
}
