import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectMemory, looksLikeSecret, projectMemoryIndex, writeMemoryNote } from "../src/project-memory.js";

test("the index lists valid notes newest first with title and two body lines, capped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  try {
    await writeFile(join(dir, "launcher-timing.md"), "# Launcher takes ~80 s warm\nAspire reports Running after 18 s.\nFrontend answers after ~60 s more.\nignored third line\n");
    await utimes(join(dir, "launcher-timing.md"), new Date("2026-09-01"), new Date("2026-09-01"));
    await writeFile(join(dir, "flaky-moderation-test.md"), "# moderation-lifecycle spec is flaky under load\nRetry once before calling it a failure.\n");
    await writeFile(join(dir, "Bad Name.md"), "# nope\n");
    await writeFile(join(dir, "leak.md"), "# token\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    await writeFile(join(dir, "huge.md"), `# big\n${"x".repeat(5000)}\n`);
    await writeFile(join(dir, "qa.json"), "{}\n");
    const index = await projectMemoryIndex(dir);
    assert.match(index.text, /^- flaky-moderation-test\.md — moderation-lifecycle spec is flaky under load\n  Retry once/m);
    assert.ok(index.text.indexOf("flaky-moderation-test.md") < index.text.indexOf("launcher-timing.md"));
    assert.match(index.text, /  Aspire reports Running after 18 s\.\n  Frontend answers after ~60 s more\.\n/);
    assert.doesNotMatch(index.text, /ignored third line|ghp_|nope|big/);
    // The private QA manifest shares this directory by design; it is neither rendered nor reported as skipped.
    assert.deepEqual(index.skipped.sort(), ["Bad Name.md", "huge.md", "leak.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the index stays within 6144 bytes and 40 files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  try {
    for (let i = 0; i < 60; i += 1) await writeFile(join(dir, `note-${String(i).padStart(2, "0")}.md`), `# note ${i}\n${"y".repeat(300)}\n`);
    const index = await projectMemoryIndex(dir);
    assert.ok(Buffer.byteLength(index.text) <= 6144);
    assert.ok((index.text.match(/^- note-/gm) ?? []).length <= 40);
    assert.ok((index.text.match(/^- note-/gm) ?? []).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absent memory directory is an empty index", async () => {
  const index = await projectMemoryIndex(join(tmpdir(), "pi-memory-does-not-exist"));
  assert.equal(index.text, "");
  assert.deepEqual(index.skipped, []);
});

test("looksLikeSecret catches tokens, bearer headers, passwords, cookies and private keys", () => {
  for (const text of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer eyJ",
    "password=1q2w3E*",
    "cookie: .AspNetCore.Identity=abc",
    "-----BEGIN RSA PRIVATE KEY-----",
    "AKIAIOSFODNN7EXAMPLE",
  ]) assert.equal(looksLikeSecret(text), true, text);
  assert.equal(looksLikeSecret("The seeded admin account is used by e2e; see the repository's seed data."), false);
});

test("writeMemoryNote creates the directory and a titled note; bad names are refused", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "pi-memory-")), "memory");
  try {
    await writeMemoryNote(dir, "instance-timing", "Instance timing", "readiness 82 s, auth 9 s");
    assert.equal(await readFile(join(dir, "instance-timing.md"), "utf8"), "# Instance timing\nreadiness 82 s, auth 9 s\n");
    await assert.rejects(writeMemoryNote(dir, "../escape", "x", "y"), /invalid memory note name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectMemory reports each skipped file once per process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-load-"));
  const dir = join(root, "memory");
  try {
    await writeMemoryNote(dir, "ok-note", "Fine", "body");
    await writeFile(join(dir, "Bad Name.md"), "# nope\n");
    const lines: string[] = [];
    const first = await loadProjectMemory({ dataDir: root }, (line) => lines.push(line));
    const second = await loadProjectMemory({ dataDir: root }, (line) => lines.push(line));
    assert.match(first.text, /ok-note\.md — Fine/);
    assert.deepEqual(second.skipped, ["Bad Name.md"]);
    assert.equal(lines.filter((line) => /memory note skipped .*Bad Name\.md/.test(line)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
