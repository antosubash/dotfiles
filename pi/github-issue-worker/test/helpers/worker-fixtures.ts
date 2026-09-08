import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import type { GitHubIssue } from "../../src/types.js";
import { IssueWorker as RuntimeIssueWorker } from "../../src/worker.js";

export const issue: GitHubIssue = {
  number: 42,
  title: "Add reusable behavior",
  body: "Acceptance criteria",
  url: "https://github.com/example/widgets/issues/42",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "pi-ready" }],
  author: { login: "maintainer" },
};

// Controller-flow tests do not exercise the independent QA service itself.
export class TestIssueWorker extends RuntimeIssueWorker {
  constructor(...args: ConstructorParameters<typeof RuntimeIssueWorker>) {
    super(args[0], args[1], {
      qaVerifier: { verify: async () => "/private/qa/result.json" },
      ...args[2],
    });
  }
}

export function config(root: string) {
  return loadConfig({
    HOME: root,
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
    PI_WORKER_DATA_DIR: join(root, "data"),
  });
}
