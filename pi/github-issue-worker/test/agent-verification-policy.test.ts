import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

// The durable tools resolve paths with NodeExecutionEnv, which expands `~` and `file://` URLs; the policy has to see
// the same path, or `read ~/.ssh/id_rsa` would pass as `<worktree>/~/.ssh/id_rsa` and read the real key.
test("policy resolves home and file URL paths the way the tools do", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-policy-home-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "inside.ts"), "ok");
  const policy = { worktree, protectedPaths: [], dockerAccess: false };
  try {
    for (const path of ["~", "~/.ssh/id_rsa", "@~/.pi/agent/auth.json", "file:///etc/passwd", `file://${homedir()}/.ssh/id_rsa`]) {
      for (const tool of ["read", "write", "edit", "grep", "find", "ls"]) {
        assert.equal(toolBlockReason(tool, { path }, policy), "Path is outside the issue worktree", `${tool} ${path}`);
      }
    }
    assert.equal(toolBlockReason("read", { path: `file://${join(worktree, "inside.ts")}` }, policy), null);
    assert.equal(toolBlockReason("read", { path: "inside copy.ts" }, policy), null);
    assert.equal(toolBlockReason("read", { path: ".env " }, policy), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
