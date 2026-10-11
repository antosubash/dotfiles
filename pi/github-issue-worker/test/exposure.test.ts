import assert from "node:assert/strict";
import test from "node:test";
import { unsafeExposureReason } from "../src/exposure.js";
import type { GhRunner } from "../src/github/gh.js";

function fakeGh(visibility: string, calls: (readonly string[])[] = []): GhRunner {
  return async (args) => {
    calls.push(args);
    return `${visibility}\n`;
  };
}

test("refuses an unsandboxed worker on a public repository", async () => {
  const calls: (readonly string[])[] = [];
  const reason = await unsafeExposureReason(fakeGh("PUBLIC", calls), "example/widgets", false, {});
  assert.match(reason ?? "", /example\/widgets is public and PI_WORKER_SANDBOX=0/);
  assert.deepEqual(calls, [["repo", "view", "example/widgets", "--json", "visibility", "-q", ".visibility"]]);
});

test("allows private and internal repositories without the sandbox", async () => {
  assert.equal(await unsafeExposureReason(fakeGh("PRIVATE"), "example/widgets", false, {}), null);
  assert.equal(await unsafeExposureReason(fakeGh("INTERNAL"), "example/widgets", false, {}), null);
});

test("allows a public repository when the sandbox is on, without asking GitHub", async () => {
  const calls: (readonly string[])[] = [];
  assert.equal(await unsafeExposureReason(fakeGh("PUBLIC", calls), "example/widgets", true, {}), null);
  assert.deepEqual(calls, []);
});

test("an explicit opt-in accepts an unsandboxed public repository", async () => {
  const env = { PI_WORKER_ALLOW_UNSANDBOXED_PUBLIC: "1" };
  assert.equal(await unsafeExposureReason(fakeGh("PUBLIC"), "example/widgets", false, env), null);
});

test("a failed visibility lookup fails closed", async () => {
  const gh: GhRunner = async () => {
    throw new Error("gh: network unreachable");
  };
  await assert.rejects(unsafeExposureReason(gh, "example/widgets", false, {}), /network unreachable/);
});
