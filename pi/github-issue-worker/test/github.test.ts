import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPullRequestChecks,
  extractFailureExcerpt,
  isActionableFeedback,
  parseWorkerCommand,
} from "../src/github.js";
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

test("pull request checks distinguish no checks, pending jobs, and actionable failures", () => {
  const none = classifyPullRequestChecks({ headRefOid: "abc", statusCheckRollup: [] });
  assert.equal(none.state, "none");

  const pending = classifyPullRequestChecks({
    headRefOid: "abc",
    statusCheckRollup: [
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/x/y/actions/runs/1/job/2" },
      { name: "tests", status: "IN_PROGRESS", conclusion: "" },
    ],
  });
  assert.equal(pending.state, "pending");

  const failed = classifyPullRequestChecks({
    headRefOid: "abc",
    statusCheckRollup: [
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
      { context: "tests", state: "FAILURE", targetUrl: "https://example.test" },
    ],
  });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.failures[0], {
    name: "tests",
    conclusion: "FAILURE",
    detailsUrl: "https://example.test",
    excerpt: null,
  });
});

test("CI excerpts redact common credentials and focus on failure context", () => {
  const excerpt = extractFailureExcerpt([
    "setup line that should not be selected",
    "token=github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "{\"token\":\"structured-secret-value-123456789\"}",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue123456",
    "postgres://worker:database-password@example.test/db",
    "AWS_SECRET_ACCESS_KEY=short-but-sensitive",
    "clientSecret=tiny-secret",
    "refresh_token=tiny-token",
    "PASSWORD=\"two word secret\"",
    "DB_PASS=shortvalue",
    "-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----",
    "context before",
    "AssertionError: expected 1 to equal 2",
    "context after",
    "tail noise",
  ].join("\n"));
  assert.doesNotMatch(excerpt, /github_pat_|structured-secret|database-password|short-but-sensitive|tiny-secret|tiny-token|two word secret|shortvalue|private-material|eyJhbGci/);
  assert.match(excerpt, /REDACTED/);
  assert.match(excerpt, /AssertionError/);
});
