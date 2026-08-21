import assert from "node:assert/strict";
import test from "node:test";
import { isActionableFeedback, parseWorkerCommand } from "../src/github.js";
import type { PullRequestFeedback } from "../src/types.js";

function feedback(overrides: Partial<PullRequestFeedback> = {}): PullRequestFeedback {
  return {
    eventKey: "conversation:1",
    source: "conversation",
    id: 1,
    body: "/pi fix the validation",
    author: "maintainer",
    authorAssociation: "MEMBER",
    createdAt: "2026-01-01T00:00:00Z",
    url: null,
    ...overrides,
  };
}

const trusted = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

test("conversation feedback requires an explicit command", () => {
  assert.equal(isActionableFeedback(feedback(), trusted), true);
  assert.equal(
    isActionableFeedback(feedback({ body: "please fix this" }), trusted),
    false,
  );
});

test("formal and inline reviews from trusted maintainers are actionable", () => {
  assert.equal(isActionableFeedback(feedback({ source: "review" }), trusted), true);
  assert.equal(
    isActionableFeedback(feedback({ source: "review_comment", authorAssociation: "NONE" }), trusted),
    false,
  );
});

test("same-login maintainer commands remain actionable when using personal gh auth", () => {
  assert.equal(isActionableFeedback(feedback({ author: "worker" }), trusted), true);
});

test("commands are normalized", () => {
  assert.equal(parseWorkerCommand("/PI Verify GIF\nextra"), "verify gif");
  assert.equal(parseWorkerCommand("ordinary text"), null);
});
