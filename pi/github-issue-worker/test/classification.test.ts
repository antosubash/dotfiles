import assert from "node:assert/strict";
import test from "node:test";
import { classifyIssue } from "../src/classification.js";
import type { GitHubIssue } from "../src/types.js";

function issue(title: string, body: string): GitHubIssue {
  return {
    number: 1,
    title,
    body,
    url: "https://example.test/issues/1",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    author: { login: "maintainer" },
  };
}

test("issue classifier selects the least expensive truthful workflow", () => {
  assert.equal(classifyIssue(issue("Change CMS copy", "Content only; update it in the editor")), "runtime-content");
  assert.equal(classifyIssue(issue("Change Page Builder widget copy", "Update the runtime-managed card in the CMS editor")), "runtime-content");
  assert.equal(classifyIssue(issue("Mobile landing figures", "Reduce card height, gap, and font size in the Stats widget CSS")), "component-ui");
  assert.equal(classifyIssue(issue("Fix login form", "The UI must call the authentication API")), "integrated-ui");
  assert.equal(classifyIssue(issue("Correct static page", "Update checked-in Markdown page content")), "source-page");
  assert.equal(classifyIssue(issue("Repair background job", "Retry failed queue processing")), "backend-only");
});
