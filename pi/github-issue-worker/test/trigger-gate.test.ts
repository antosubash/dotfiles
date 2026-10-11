import assert from "node:assert/strict";
import test from "node:test";
import { TooManyEditsError, type TrustService } from "../src/github/trust.js";
import { checkTrigger } from "../src/worker/trigger-gate.js";

const item = { number: 7, title: "T", body: "B", author: { login: "owner" } };
function trust(over: Partial<{ writers: string[]; labeledBy: string | null; labeledAt: string | null; renames: { editor: string | null; editedAt: string }[]; edits: { editor: string | null; editedAt: string }[] | Error }> = {}): TrustService {
  const writers = new Set(over.writers ?? ["owner"]);
  return {
    canWrite: async (login) => writers.has(login.toLowerCase()),
    approval: async () => ({ labeledBy: over.labeledBy === undefined ? "owner" : over.labeledBy, labeledAt: over.labeledAt === undefined ? "2026-01-02T00:00:00Z" : over.labeledAt, renames: over.renames ?? [] }),
    bodyEdits: async () => { if (over.edits instanceof Error) throw over.edits; return over.edits ?? []; },
    viewerLogin: async () => "owner",
  };
}

test("admits when author, labeller and editors can write and nothing changed after the label", async () => {
  const result = await checkTrigger(trust({ edits: [{ editor: "owner", editedAt: "2026-01-01T00:00:00Z" }] }), item, "pi-ready");
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.hash : "", /^[0-9a-f]{64}$/);
});

test("an edit in the same second as the label is admitted (strictly after rejects)", async () => {
  const same = await checkTrigger(trust({ edits: [{ editor: "owner", editedAt: "2026-01-02T00:00:00Z" }] }), item, "pi-ready");
  assert.equal(same.ok, true);
});

for (const [name, over, pattern] of [
  ["author without write", { writers: ["maint"], labeledBy: "maint" }, /author `owner` doesn't have write access/],
  ["no label event", { labeledBy: null, labeledAt: null }, /no `pi-ready` label event/],
  ["labeller without write", { labeledBy: "outsider" }, /added by `outsider`/],
  ["body edited by an outsider", { edits: [{ editor: "outsider", editedAt: "2026-01-01T00:00:00Z" }] }, /edited by `outsider`/],
  ["body edited by a deleted account", { edits: [{ editor: null, editedAt: "2026-01-01T00:00:00Z" }] }, /edited by `a deleted account`/],
  ["title renamed after the label", { renames: [{ editor: "owner", editedAt: "2026-01-03T00:00:00Z" }] }, /edited after `pi-ready` was added/],
  ["body edited after the label", { edits: [{ editor: "owner", editedAt: "2026-01-03T00:00:00Z" }] }, /edited after `pi-ready` was added/],
  ["too many edits", { edits: new TooManyEditsError("x") }, /too many edits to verify/],
] as const) {
  test(`rejects: ${name}`, async () => {
    const result = await checkTrigger(trust(over as never), item, "pi-ready");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, pattern);
  });
}

test("transient errors propagate instead of rejecting", async () => {
  await assert.rejects(checkTrigger(trust({ edits: new Error("HTTP 502") }), item, "pi-ready"), /502/);
});
