import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GitHubClient } from "../src/github.js";
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

test("open PR overlap detection excludes the worker branch", async () => {
  const client = new GitHubClient(
    loadConfig({
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_ALLOW_DOCKER: "0",
    }),
    async (args) => {
      assert.deepEqual(args.slice(0, 3), ["api", "--paginate", "--slurp"]);
      return JSON.stringify([[
        { number: 7, html_url: "https://example.test/pull/7", head: { ref: "feature/existing" }, title: "Fix #42", body: "" },
        { number: 8, html_url: "https://example.test/pull/8", head: { ref: "pi/issue-42" }, title: "Worker", body: "Closes #42" },
        { number: 9, html_url: "https://example.test/pull/9", head: { ref: "other" }, title: "Fix #420", body: "" },
      ]]);
    },
  );
  assert.deepEqual(await client.findOpenPullRequestsForIssue(42, "pi/issue-42"), [
    { number: 7, url: "https://example.test/pull/7" },
  ]);
});

test("ready pull requests expose their trusted same-repository head metadata", async () => {
  const client = new GitHubClient(
    loadConfig({
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_ALLOW_DOCKER: "0",
    }),
    async (args) => {
      assert.deepEqual(args.slice(0, 8), [
        "pr",
        "list",
        "--repo",
        "example/widgets",
        "--state",
        "open",
        "--label",
        "pi-ready",
      ]);
      return JSON.stringify([
        {
          number: 88,
          title: "Adopt me",
          body: null,
          url: "https://example.test/pull/88",
          updatedAt: "2026-09-01T00:00:00Z",
          labels: [{ name: "pi-ready" }],
          author: { login: "maintainer" },
          headRefName: "feature/adopt-me",
          headRefOid: "abc123",
          baseRefName: "main",
          isCrossRepository: false,
        },
      ]);
    },
  );
  assert.deepEqual(await client.listReadyPullRequests(), [
    {
      number: 88,
      title: "Adopt me",
      body: "",
      url: "https://example.test/pull/88",
      updatedAt: "2026-09-01T00:00:00Z",
      labels: [{ name: "pi-ready" }],
      author: { login: "maintainer" },
      headRefName: "feature/adopt-me",
      headRefOid: "abc123",
      baseRefName: "main",
      isCrossRepository: false,
    },
  ]);
});

test("pull requests inherit source issue labels without transient worker state", async () => {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const client = new GitHubClient(
    loadConfig({
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_LABEL_PREFIX: "agent",
      PI_WORKER_ALLOW_DOCKER: "0",
    }),
    async (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      return "";
    },
  );
  await client.labelPullRequestFromIssue(7, {
    number: 42,
    title: "Fix widget",
    body: "Acceptance criteria",
    url: "https://example.test/issues/42",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [
      { name: "agent-ready" },
      { name: "bug" },
      { name: "agent-working" },
      { name: "agent-visual" },
      { name: "AGENT-PR-OPEN" },
      { name: "agent-blocked" },
    ],
    author: { login: "maintainer" },
  });
  assert.deepEqual(calls[0]?.args, [
    "api",
    "--method",
    "POST",
    "/repos/example/widgets/issues/7/labels",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(calls[0]?.input || "{}"), {
    labels: ["agent-pr-open", "bug", "agent-visual"],
  });
});

test("evidence publication is idempotent and advances the branch without force", async () => {
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const attachment = {
    name: "desktop.png",
    content: Buffer.from("png"),
    mediaType: "image/png" as const,
  };
  const expectedPath = "qa/pr-7/abcdef123456/run/desktop.png";

  for (const alreadyPublished of [true, false]) {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const client = new GitHubClient(
      loadConfig({
        PI_WORKER_REPOSITORY: "example/widgets",
        PI_WORKER_BASE_BRANCH: "main",
        PI_WORKER_ALLOW_DOCKER: "0",
      }),
      async (args, input) => {
        calls.push({ args, ...(input === undefined ? {} : { input }) });
        const endpoint = args.find((value) => value.startsWith("/repos/")) || "";
        if (endpoint.includes("/git/ref/heads/")) return JSON.stringify({ object: { sha: "head" } });
        if (endpoint.endsWith("/git/commits/head")) return JSON.stringify({ tree: { sha: "tree" } });
        if (endpoint.includes("/git/trees/tree?")) {
          return JSON.stringify({
            tree: alreadyPublished
              ? [{ path: expectedPath, type: "blob", sha: "blob" }]
              : [],
          });
        }
        if (endpoint.includes("/commits?sha=")) {
          return JSON.stringify([[
            {
              sha: "head",
              parents: [{ sha: "root" }],
              commit: { message: "qa: publish evidence for PR #7", tree: { sha: "tree" } },
            },
            {
              sha: "root",
              parents: [],
              commit: { message: "Initialize Pi QA evidence branch", tree: { sha: emptyTree } },
            },
          ]]);
        }
        if (args.includes("graphql")) {
          return JSON.stringify({
            data: {
              repository: {
                t0: { entries: [{ name: "qa", type: "tree" }] },
                t1: { entries: [] },
              },
            },
          });
        }
        if (endpoint.endsWith("/git/blobs")) return JSON.stringify({ sha: "blob" });
        if (endpoint.endsWith("/git/trees")) return JSON.stringify({ sha: "next-tree" });
        if (endpoint.endsWith("/git/commits")) return JSON.stringify({ sha: "next-head" });
        if (endpoint.includes("/git/refs/heads/")) return "";
        throw new Error(`Unexpected mock gh call: ${args.join(" ")}`);
      },
    );

    const markdown = await client.publishEvidence(7, "abcdef1234567890", "run", [attachment]);
    assert.match(markdown, /desktop\.png/);
    const updates = calls.filter(({ args }) => args.includes("PATCH"));
    assert.equal(updates.length, alreadyPublished ? 0 : 1);
    if (!alreadyPublished) {
      assert.deepEqual(JSON.parse(updates[0]!.input!), { sha: "next-head", force: false });
    }
  }
});

test("blocking an invalid ready PR removes the adoption label", async () => {
  const calls: string[][] = [];
  const client = new GitHubClient(
    loadConfig({
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_ALLOW_DOCKER: "0",
    }),
    async (args) => {
      calls.push([...args]);
      return "";
    },
  );
  await client.markBlocked(88, "Invalid adoption target");
  const edit = calls[0]!;
  assert.deepEqual(edit.slice(0, 4), ["issue", "edit", "88", "--repo"]);
  assert.ok(edit.includes("pi-ready"));
  assert.ok(edit.includes("pi-blocked"));
});

