import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  loadProjectMemory, memoryDirectory, projectMemoryIndex, writeMemoryNote,
  MEMORY_FILE_BYTES, MEMORY_FILES, MEMORY_INDEX_BYTES,
} from "../src/project-memory.js";
import { memoryInstructions } from "../src/prompts/shared.js";

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("notes survive separate writer and reader processes and reach the prompt", async (t) => {
  const root = await fixture(t);
  const moduleUrl = new URL("../src/project-memory.ts", import.meta.url).href;
  const run = (code: string) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
      encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  run(`import { writeMemoryNote, memoryDirectory } from ${JSON.stringify(moduleUrl)};
    await writeMemoryNote(memoryDirectory({ dataDir: ${JSON.stringify(root)} }), "launcher-timing", "Launcher timing", "Ready after 82 seconds.");`);
  const index = JSON.parse(run(`import { loadProjectMemory } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await loadProjectMemory({ dataDir: ${JSON.stringify(root)} })));`));
  assert.equal(index.dir, join(root, "memory"));
  assert.match(index.text, /launcher-timing\.md — Launcher timing\n  Ready after 82 seconds\./);
  const prompt = memoryInstructions(index);
  assert.match(prompt, /<untrusted-project-memory>/);
  assert.match(prompt, /Ready after 82 seconds\./);
  assert.match(prompt, /advisory, verify before relying on them/);
});

test("profiles isolate notes and rewriting a slug replaces rather than duplicates it", async (t) => {
  const root = await fixture(t);
  const a = { dataDir: join(root, "profile-a") };
  const b = { dataDir: join(root, "profile-b") };
  await writeMemoryNote(memoryDirectory(a), "timing", "Profile A", "Old timing.");
  await writeMemoryNote(memoryDirectory(b), "timing", "Profile B", "Other repository.");
  await writeMemoryNote(memoryDirectory(a), "timing", "Profile A", "Updated timing.");
  const first = await loadProjectMemory(a);
  const second = await loadProjectMemory(b);
  assert.match(first.text, /Updated timing/);
  assert.doesNotMatch(first.text, /Old timing|Profile B|Other repository/);
  assert.match(second.text, /Other repository/);
  assert.doesNotMatch(second.text, /Profile A|Updated timing/);
  assert.deepEqual(await readdir(memoryDirectory(a)), ["timing.md"]);
});

test("the 40-file limit selects exactly the newest notes independently of the byte cap", async (t) => {
  const dir = await fixture(t);
  for (let i = 0; i < MEMORY_FILES + 5; i += 1) {
    const path = join(dir, `note-${i}.md`);
    await writeFile(path, `# ${i}\n`);
    const time = new Date(1_700_000_000_000 + i * 1000);
    await utimes(path, time, time);
  }
  const index = await projectMemoryIndex(dir);
  const names = [...index.text.matchAll(/^- (note-\d+\.md) —/gm)].map((match) => match[1]);
  assert.deepEqual(names, Array.from({ length: MEMORY_FILES }, (_, i) => `note-${MEMORY_FILES + 4 - i}.md`));
  assert.ok(Buffer.byteLength(index.text) < MEMORY_INDEX_BYTES);
});

test("the note size boundary is inclusive and measured in UTF-8 bytes", async (t) => {
  const dir = await fixture(t);
  const exact = `# x\n${"é".repeat((MEMORY_FILE_BYTES - 4) / 2)}`;
  assert.equal(Buffer.byteLength(exact), MEMORY_FILE_BYTES);
  await writeFile(join(dir, "exact.md"), exact);
  await writeFile(join(dir, "over.md"), `${exact}x`);
  const index = await projectMemoryIndex(dir);
  assert.match(index.text, /exact\.md/);
  assert.doesNotMatch(index.text, /over\.md/);
  assert.deepEqual(index.skipped, ["over.md"]);
});

test("the index byte cap preserves complete entries with multibyte content", async (t) => {
  const dir = await fixture(t);
  const body = "🧠".repeat(250);
  for (let i = 0; i < 10; i += 1) await writeFile(join(dir, `note-${i}.md`), `# Memory\n${body}\n`);
  const index = await projectMemoryIndex(dir);
  assert.ok(Buffer.byteLength(index.text) <= MEMORY_INDEX_BYTES);
  assert.equal((index.text.match(/^- note-/gm) ?? []).length, 5);
  assert.equal((index.text.match(new RegExp(`  ${body}\\n`, "g")) ?? []).length, 5);
  assert.ok(Buffer.byteLength(index.text) + Buffer.byteLength(`- note-0.md — Memory\n  ${body}\n`) > MEMORY_INDEX_BYTES);
});

test("secret filtering scans beyond the two preview lines and logs no secret content", async (t) => {
  const root = await fixture(t);
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  await writeMemoryNote(memoryDirectory({ dataDir: root }), "hidden-secret", "Ordinary title", `Safe first line.\nSafe second line.\n${secret}`);
  const logs: string[] = [];
  const index = await loadProjectMemory({ dataDir: root }, (line) => logs.push(line));
  assert.equal(index.text, "");
  assert.deepEqual(index.skipped, ["hidden-secret.md"]);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]);
  assert.match(logs[0], /hidden-secret\.md/);
  assert.ok(!logs.join("\n").includes(secret));
  assert.ok(!memoryInstructions(index).includes(secret));
});

test("new notes have private permissions and non-files and invalid names are skipped", async (t) => {
  const root = await fixture(t);
  const dir = join(root, "memory");
  await writeMemoryNote(dir, "private-note", "Private", "Durable fact.");
  if (process.platform !== "win32") {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "private-note.md"))).mode & 0o777, 0o600);
  }
  await mkdir(join(dir, "directory.md"));
  await writeFile(join(dir, "wrong.txt"), "not a note");
  const index = await projectMemoryIndex(dir);
  assert.deepEqual(index.skipped.sort(), ["directory.md", "wrong.txt"]);
  for (const slug of ["../escape", "/absolute", "Uppercase", "has space", "", "a".repeat(65)]) {
    await assert.rejects(writeMemoryNote(dir, slug, "Title", "Body"), /invalid memory note name/);
  }
  await writeMemoryNote(dir, "a".repeat(64), "Maximum slug", "Accepted.");
  assert.match((await projectMemoryIndex(dir)).text, /Maximum slug/);
});
