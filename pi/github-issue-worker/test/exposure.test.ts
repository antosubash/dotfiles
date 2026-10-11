import assert from "node:assert/strict";
import test from "node:test";
import { keyringWarning, unsafeExposureReason } from "../src/exposure.js";
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

test("keyringWarning is silent, without asking GitHub, when a token is configured", async () => {
  const calls: (readonly string[])[] = [];
  assert.equal(await keyringWarning(fakeGh("PUBLIC", calls), "example/widgets", { GH_TOKEN: "x" }), null);
  assert.equal(await keyringWarning(fakeGh("PUBLIC", calls), "example/widgets", { GITHUB_TOKEN: "x" }), null);
  assert.deepEqual(calls, []);
});

test("keyringWarning flags a public repository that falls back to the keyring login", async () => {
  assert.match((await keyringWarning(fakeGh("PUBLIC"), "example/widgets", {})) ?? "", /keyring login/);
});

test("keyringWarning is silent for a private repository", async () => {
  assert.equal(await keyringWarning(fakeGh("PRIVATE"), "example/widgets", {}), null);
});
