import assert from "node:assert/strict";
import { lstat, mkdtemp, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertWebmToGif, createEvidenceRun } from "../src/evidence.js";
import { commandExists, execFile } from "../src/exec.js";

test("evidence runs stay under ignored .qa and update latest symlink", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "pi-worker-evidence-"));
  try {
    const run = await createEvidenceRun(worktree, 42, 99, new Date("2026-08-21T10:30:00Z"));
    assert.match(run.relativeRunDir, /^\.qa\/issues\/42\/pr-99\/runs\//);
    const latest = join(run.issueRoot, "latest");
    assert.equal((await lstat(latest)).isSymbolicLink(), true);
    assert.equal(await readlink(latest), "runs/20260821T103000Z");
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("ffmpeg converts a Playwright-style WebM recording to GIF", async (context) => {
  if (!(await commandExists("ffmpeg"))) {
    context.skip("ffmpeg is not installed");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-gif-"));
  const webm = join(directory, "workflow.webm");
  const gif = join(directory, "workflow.gif");
  try {
    await execFile(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:d=0.3",
        "-c:v",
        "libvpx-vp9",
        webm,
      ],
      { timeoutMs: 30_000 },
    );
    await convertWebmToGif(webm, gif);
    assert.ok((await stat(gif)).size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
