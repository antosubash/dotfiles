import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { toolBlockReason } from "../src/agent/policy.js";

test("verifier policy resolves tool-relative paths against the worktree before evidence exceptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-verifier-policy-"));
  const worktree = join(root, "worktree");
  const evidenceDir = join(root, "evidence");
  const reference = join(root, "reference");
  for (const path of [worktree, evidenceDir, reference]) await mkdir(path);
  await writeFile(join(worktree, "source.ts"), "source");
  await writeFile(join(reference, "summary.json"), "{}");
  const policy = {
    worktree, protectedPaths: [".git"], dockerAccess: false,
    verification: { evidenceDir, readPaths: [reference] },
  };
  try {
    const blocked = (toolName: string, path?: string) => toolBlockReason(toolName, path === undefined ? {} : { path }, policy) !== null;
    for (const tool of ["write", "edit"]) {
      assert.equal(blocked(tool, "source.ts"), true, `${tool} relative source`);
      assert.equal(blocked(tool, "nested/new.ts"), true, `${tool} nested new source`);
      assert.equal(blocked(tool, "@source.ts"), true, `${tool} @ source`);
      assert.equal(blocked(tool, join(reference, "summary.json")), true, `${tool} reference`);
      assert.equal(blocked(tool, join(evidenceDir, "report.md")), false, `${tool} absolute evidence`);
      assert.equal(blocked(tool, relative(worktree, join(evidenceDir, "report.md"))), false, `${tool} relative evidence`);
    }
    for (const tool of ["read", "grep", "find", "ls"]) {
      assert.equal(blocked(tool, "source.ts"), false);
      assert.equal(blocked(tool, join(reference, "summary.json")), false);
      assert.equal(blocked(tool, root), true);
      assert.equal(blocked(tool, ".env"), true);
    }
    assert.equal(blocked("ls"), false);
    assert.equal(blocked("grep"), false);
    await symlink(worktree, join(evidenceDir, "escape"));
    assert.equal(blocked("write", join(evidenceDir, "escape", "nested", "new.ts")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
