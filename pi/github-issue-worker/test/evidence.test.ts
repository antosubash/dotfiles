import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectEvidenceAttachments,
  convertWebmToGif,
  createEvidenceRun,
  listEvidenceRuns,
} from "../src/evidence.js";
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

test("all evidence runs remain recoverable and symlinked ancestors fail closed", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "pi-worker-run-list-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-worker-run-outside-"));
  try {
    const runsRoot = join(worktree, ".qa/issues/4/pr-9/runs");
    await writeFile(join(outside, "proof.png"), "not relevant");
    await mkdir(join(runsRoot, "run-a"), { recursive: true });
    await mkdir(join(runsRoot, "run-b"), { recursive: true });
    assert.deepEqual(
      (await listEvidenceRuns(worktree, 4, 9)).map((run) => run.runDir.split("/").at(-1)),
      ["run-a", "run-b"],
    );
    const linked = join(worktree, "linked-run");
    await symlink(outside, linked);
    await assert.rejects(() => collectEvidenceAttachments(linked), /contains a symlink/);
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("only signature-validated visual artifacts are publishable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-attachments-"));
  try {
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(
      join(directory, "desktop.png"),
      Buffer.concat([validPng, Buffer.from("SECRET_TRAILER")]),
    );
    await writeFile(join(directory, "report.md"), "not uploaded");
    const attachments = await collectEvidenceAttachments(directory);
    assert.deepEqual(attachments.map(({ name, mediaType }) => ({ name, mediaType })), [
      { name: "desktop.png", mediaType: "image/png" },
    ]);
    assert.equal(attachments[0]!.content.includes(Buffer.from("SECRET_TRAILER")), false);
    await writeFile(join(directory, "unsafe].png"), validPng);
    await assert.rejects(() => collectEvidenceAttachments(directory), /unsafe filename/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GIF conversion rejects agent-controlled symlink sources and destinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-gif-links-"));
  try {
    const realInput = join(directory, "real.webm");
    const linkedInput = join(directory, "linked.webm");
    const realOutput = join(directory, "real.gif");
    const linkedOutput = join(directory, "linked.gif");
    await writeFile(realInput, "not needed for the preflight check");
    await writeFile(realOutput, "protected");
    await symlink(realInput, linkedInput);
    await symlink(realOutput, linkedOutput);
    await assert.rejects(
      () => convertWebmToGif(linkedInput, join(directory, "new.gif")),
      /source must be a regular file/,
    );
    await assert.rejects(
      () => convertWebmToGif(realInput, linkedOutput),
      /destination must be a regular file/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
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
