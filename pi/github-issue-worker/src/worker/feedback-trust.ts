import type { TrustService } from "../github/trust.js";
import type { PullRequestFeedback } from "../types.js";

/** author_association is only a prefilter; act on feedback only from users with write access. */
export async function writableFeedback(
  trust: TrustService,
  items: readonly PullRequestFeedback[],
): Promise<PullRequestFeedback[]> {
  const kept: PullRequestFeedback[] = [];
  for (const item of items) if (await trust.canWrite(item.author)) kept.push(item);
  return kept;
}
