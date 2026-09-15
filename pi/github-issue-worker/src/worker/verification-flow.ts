import type { AppInstance } from "../app-instance/index.js";
import type { GitHubIssue, IssueJob } from "../types.js";
import type { WorkerContext } from "./shared.js";

export interface VerificationOutcome {
  /** The prose the flows append to the agent's final text. */
  text: string;
  /** Absolute path of the QA verifier's `result.json`; its run directory holds the browser evidence. */
  qaReport: string;
}

/** Run fresh acceptance and design verification before every controller mutation. */
export async function verifyImplementationDetailed(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: string,
  issue?: GitHubIssue,
  instance: AppInstance | null = null,
): Promise<VerificationOutcome> {
  const original = issue ?? await ctx.github.getIssue(job.issueNumber);
  const plan = await ctx.plans.load(original);
  await instance?.ensureCurrent();
  const qaReport = await ctx.qaVerifier.verify(original, worktree, plan, { instance });
  const designReport = await ctx.designVerifier.verify(original, worktree, plan);
  const text = `\n\nIndependent QA passed. Local report: \`${qaReport}\`.` +
    (designReport ? `\nIndependent Figma design verification passed. Local private report: \`${designReport}\`.` : "");
  return { text, qaReport };
}

export async function verifyImplementation(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: string,
  issue?: GitHubIssue,
  instance: AppInstance | null = null,
): Promise<string> {
  return (await verifyImplementationDetailed(ctx, job, worktree, issue, instance)).text;
}
