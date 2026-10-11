import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GitHubClient } from "../src/github.js";

function client(deleteError: Error | null) {
  const calls: string[] = [];
  const github = new GitHubClient(
    loadConfig({ PI_WORKER_REPOSITORY: "example/widgets", PI_WORKER_BASE_BRANCH: "main", PI_WORKER_ALLOW_DOCKER: "0" }),
    async (args, input) => {
      calls.push(`${args[2]} ${args[3]}${input ? ` ${input}` : ""}`);
      if (args[2] === "DELETE" && deleteError) throw deleteError;
      return "";
    },
  );
  return { github, calls };
}

test("rejecting a trigger removes both labels, tolerating an absent one, then comments once", async () => {
  const { github, calls } = client(new Error("gh: Label does not exist (HTTP 404)"));
  await github.rejectTrigger(7, "pi-plan", "⛔ Not started: nope.");
  assert.deepEqual(calls.slice(0, 2), [
    "DELETE /repos/example/widgets/issues/7/labels/pi-plan",
    "DELETE /repos/example/widgets/issues/7/labels/pi-ready",
  ]);
  assert.equal(calls.length, 3);
  assert.match(calls[2]!, /^POST \/repos\/example\/widgets\/issues\/7\/comments .*<!-- pi-issue-worker -->\\n⛔ Not started: nope\./);
});

test("a non-404 label removal failure throws before commenting, so a later poll can't comment twice", async () => {
  const { github, calls } = client(new Error("gh: Server Error (HTTP 502)"));
  await assert.rejects(github.rejectTrigger(7, "pi-ready", "⛔ Not started: nope."), /HTTP 502/);
  assert.ok(!calls.some((call) => call.startsWith("POST")));
});
