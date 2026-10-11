import type { TrustService } from "../github/trust.js";
import type { PullRequestFeedback } from "../types.js";

/**
 * author_association is only a prefilter; act on feedback only from users with write access. `denied` holds
 * items whose author definitively lacks it: callers mark them processed so they cannot fire later if that
 * user is granted access. A failed permission lookup rejects, leaving every item unprocessed for the next poll.
 */
export async function partitionFeedback(
  trust: TrustService,
  items: readonly PullRequestFeedback[],
): Promise<{ writable: PullRequestFeedback[]; denied: PullRequestFeedback[] }> {
  const writable: PullRequestFeedback[] = [];
  const denied: PullRequestFeedback[] = [];
  for (const item of items) (await trust.canWrite(item.author) ? writable : denied).push(item);
  return { writable, denied };
}
