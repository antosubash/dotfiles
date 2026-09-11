import { BranchDivergenceError } from "../repository.js";
import { errorText, RetryableControllerError, type WorkerContext } from "./shared.js";

/**
 * One resolution attempt per (PR, base branch, head, base) — note GitHub's baseRefOid moves only when the
 * PR syncs, so a processed key stays processed until `/pi retry` forgets it or the PR head changes.
 */
export function mergeConflictEventKey(
  prNumber: number,
  mergeState: { baseBranch: string; headSha: string; baseSha: string },
): string {
  return `merge-conflict:${prNumber}:${mergeState.baseBranch}:${mergeState.headSha}:${mergeState.baseSha}`;
}

/**
 * Confirm the pull request still has the head and base the resolution was computed against. A read that
 * fails outright (expired token, outage) is not a moved pull request: it is retryable, and the caller must
 * keep the staged merge rather than discard a resolution that may already have passed verification.
 */
export async function assertPullRequestMergeContext(
  ctx: WorkerContext,
  prNumber: number,
  expectedHead: string,
  expectedBase: string,
): Promise<void> {
  let current;
  try {
    current = await ctx.github.getPullRequestMergeState(prNumber);
  } catch (error) {
    throw new RetryableControllerError(`GitHub could not confirm the merge context: ${errorText(error)}`);
  }
  if (
    current.baseBranch !== ctx.config.baseBranch ||
    current.headSha !== expectedHead ||
    current.baseSha !== expectedBase
  ) {
    throw new BranchDivergenceError(
      `Pull request merge context moved while resolving conflicts (base ${current.baseBranch}@${current.baseSha}, head ${current.headSha})`,
    );
  }
}
