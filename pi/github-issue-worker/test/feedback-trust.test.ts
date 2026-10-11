import assert from "node:assert/strict";
import test from "node:test";
import type { TrustService } from "../src/github/trust.js";
import type { PullRequestFeedback } from "../src/types.js";
import { writableFeedback } from "../src/worker/feedback-trust.js";
import { trustingTrust } from "./helpers/worker-fixtures.js";

function item(id: number, author: string): PullRequestFeedback {
  return {
    eventKey: `conversation:${id}`, source: "conversation", id, body: "/pi fix x",
    author, authorAssociation: "MEMBER", createdAt: "2026-01-02T00:00:00Z", url: null,
  };
}

test("writableFeedback keeps writers' items in order and drops everyone else's", async () => {
  const trust: TrustService = { ...trustingTrust, canWrite: async (login) => login === "owner" };
  const kept = await writableFeedback(trust, [item(1, "owner"), item(2, "triager"), item(3, "owner")]);
  assert.deepEqual(kept.map((entry) => entry.id), [1, 3]);
});

test("writableFeedback rejects when the permission lookup fails, so callers leave events unprocessed", async () => {
  const trust: TrustService = { ...trustingTrust, canWrite: async () => { throw new Error("HTTP 502"); } };
  await assert.rejects(writableFeedback(trust, [item(1, "owner")]), /502/);
});
