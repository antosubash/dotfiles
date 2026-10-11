import assert from "node:assert/strict";
import test from "node:test";
import type { GhRunner } from "../src/github/gh.js";
import { GitHubTrust, TooManyEditsError } from "../src/github/trust.js";

function fake(routes: Record<string, string | Error>, calls: string[] = []): GhRunner {
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    const hit = Object.entries(routes).find(([pattern]) => key.includes(pattern));
    if (!hit) throw new Error(`unexpected gh call: ${key}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
}

test("write, maintain and admin can write; triage, read and 404 cannot", async () => {
  for (const [permission, expected] of [["write", true], ["maintain", true], ["admin", true], ["triage", false], ["read", false], ["none", false]] as const) {
    const trust = new GitHubTrust(fake({ "/permission": `${permission}\n` }), "o/r");
    assert.equal(await trust.canWrite("u"), expected, permission);
  }
  const missing = new GitHubTrust(fake({ "/permission": new Error("gh api /repos/o/r/collaborators/ghost/permission --jq .permission failed (1)\ngh: Not Found (HTTP 404)") }), "o/r");
  assert.equal(await missing.canWrite("ghost"), false);
});

test("other permission errors throw so callers retry", async () => {
  const trust = new GitHubTrust(fake({ "/permission": new Error("HTTP 502: Bad Gateway") }), "o/r");
  await assert.rejects(trust.canWrite("u"), /502/);
});

test("a 502 whose command line contains a standalone 404 still throws", async () => {
  const error = new Error("gh api /repos/o/my-404-repo/collaborators/user-404/permission --jq .permission failed (1)\ngh: Bad Gateway (HTTP 502)");
  const trust = new GitHubTrust(fake({ "/permission": error }), "o/my-404-repo");
  await assert.rejects(trust.canWrite("user-404"), /502/);
});

test("permission is cached per lowercased login for 10 minutes", async () => {
  let now = 0;
  const calls: string[] = [];
  const trust = new GitHubTrust(fake({ "/permission": "write" }, calls), "o/r", () => now);
  await trust.canWrite("Owner");
  await trust.canWrite("owner");
  assert.equal(calls.length, 1);
  now = 10 * 60_000 + 1;
  await trust.canWrite("owner");
  assert.equal(calls.length, 2);
});

test("approval returns the last ready-label event and all renames", async () => {
  const events = JSON.stringify([[
    { event: "labeled", label: { name: "pi-ready" }, actor: { login: "a" }, created_at: "2026-01-01T00:00:00Z" },
    { event: "renamed", actor: { login: "b" }, created_at: "2026-01-02T00:00:00Z" },
    { event: "labeled", label: { name: "PI-READY" }, actor: { login: "c" }, created_at: "2026-01-03T00:00:00Z" },
    { event: "labeled", label: { name: "pi-working" }, actor: { login: "d" }, created_at: "2026-01-04T00:00:00Z" },
  ]]);
  const trust = new GitHubTrust(fake({ "/issues/7/events": events }), "o/r");
  assert.deepEqual(await trust.approval(7, "pi-ready"), {
    labeledBy: "c",
    labeledAt: "2026-01-03T00:00:00Z",
    renames: [{ editor: "b", editedAt: "2026-01-02T00:00:00Z" }],
  });
});

test("bodyEdits maps editors and keeps deleted accounts as null", async () => {
  const page = JSON.stringify({ nodes: [{ editor: { login: "a" }, editedAt: "t1" }, { editor: null, editedAt: "t2" }], pageInfo: { hasNextPage: false } });
  const trust = new GitHubTrust(fake({ graphql: page }), "o/r");
  assert.deepEqual(await trust.bodyEdits(7), [{ editor: "a", editedAt: "t1" }, { editor: null, editedAt: "t2" }]);
});

test("more than one page of edits fails closed", async () => {
  const page = JSON.stringify({ nodes: [], pageInfo: { hasNextPage: true } });
  const trust = new GitHubTrust(fake({ graphql: page }), "o/r");
  await assert.rejects(trust.bodyEdits(7), TooManyEditsError);
});

test("viewerLogin caches success; failure returns null and is retried", async () => {
  const calls: string[] = [];
  const ok = new GitHubTrust(fake({ "api user": "worker-bot\n" }, calls), "o/r");
  assert.equal(await ok.viewerLogin(), "worker-bot");
  assert.equal(await ok.viewerLogin(), "worker-bot");
  assert.equal(calls.length, 1);
  const brokenCalls: string[] = [];
  const broken = new GitHubTrust(fake({ "api user": new Error("401") }, brokenCalls), "o/r");
  assert.equal(await broken.viewerLogin(), null);
  assert.equal(await broken.viewerLogin(), null);
  assert.equal(brokenCalls.length, 2);
});
