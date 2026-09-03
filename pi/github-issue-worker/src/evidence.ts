import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "./exec.js";

export interface EvidenceAttachment {
  name: string;
  content: Buffer;
  mediaType: "image/png" | "image/gif" | "video/webm";
}

export interface EvidenceRun {
  issueNumber: number;
  prNumber: number | null;
  runId: string;
  issueRoot: string;
  runDir: string;
  relativeRunDir: string;
}

function timestamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function createEvidenceRun(
  worktree: string,
  issueNumber: number,
  prNumber: number | null,
  now = new Date(),
): Promise<EvidenceRun> {
  const runId = timestamp(now);
  const issueRoot = join(worktree, ".qa", "issues", String(issueNumber), `pr-${prNumber ?? "pending"}`);
  const runDir = join(issueRoot, "runs", runId);
  // This controller method intentionally performs no writes beneath agent-controlled
  // evidence storage. The sandboxed visual run creates its assigned directory; later
  // collection requires a canonical non-symlinked directory before reading anything.
  await assertSafeEvidenceParent(worktree, dirname(runDir));
  return {
    issueNumber,
    prNumber,
    runId,
    issueRoot,
    runDir,
    relativeRunDir: relative(worktree, runDir),
  };
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const canonical = await realpath(path);
  const info = await lstat(path);
  if (canonical !== resolve(path) || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`QA evidence directory contains a symlink: ${path}`);
  }
}

async function assertSafeEvidenceParent(root: string, targetParent: string): Promise<void> {
  await assertCanonicalDirectory(root);
  const canonicalRoot = resolve(root);
  const target = resolve(targetParent);
  const pathFromRoot = relative(canonicalRoot, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("QA evidence directory escapes the worktree");
  }
  let current = canonicalRoot;
  for (const segment of pathFromRoot.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    await assertCanonicalDirectory(current);
  }
}

export async function listEvidenceRuns(
  worktree: string,
  issueNumber: number,
  prNumber: number | null,
): Promise<EvidenceRun[]> {
  const issueRoot = join(worktree, ".qa", "issues", String(issueNumber), `pr-${prNumber ?? "pending"}`);
  const runsRoot = join(issueRoot, "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const runs: EvidenceRun[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runDir = join(runsRoot, entry.name);
    try {
      await assertCanonicalDirectory(runDir);
      runs.push({
        issueNumber,
        prNumber,
        runId: entry.name,
        issueRoot,
        runDir,
        relativeRunDir: relative(worktree, runDir),
      });
    } catch {
      // Fail closed on replaced run directories; other controller-created runs remain recoverable.
    }
  }
  return runs;
}

export async function findLatestEvidenceRun(
  worktree: string,
  issueNumber: number,
  prNumber: number | null,
): Promise<EvidenceRun | null> {
  // Enumerate canonical run directories instead of trusting the mutable legacy
  // `latest` symlink, which may remain stale after controller-side allocation
  // stopped writing beneath agent-controlled evidence storage.
  const runs = await listEvidenceRuns(worktree, issueNumber, prNumber);
  return runs.at(-1) ?? null;
}

async function sandboxedFfmpeg(
  source: string,
  outputDirectory: string,
  outputName: string,
  codecArgs: readonly string[],
): Promise<void> {
  await execFile(
    "bwrap",
    [
      "--die-with-parent",
      "--unshare-all",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/bin",
      "/bin",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/etc/alternatives",
      "/etc/alternatives",
      "--ro-bind-try",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--ro-bind",
      source,
      "/input",
      "--bind",
      outputDirectory,
      "/output",
      "--chdir",
      "/output",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "/usr/bin/ffmpeg",
      "-v",
      "error",
      "-nostdin",
      "-i",
      "/input",
      "-map",
      "0:v:0",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      ...codecArgs,
      `/output/${outputName}`,
    ],
    { timeoutMs: 120_000, maxOutputChars: 8_000, env: { PATH: process.env.PATH || "/usr/bin:/bin" } },
  );
}

async function sanitizedMedia(
  source: string,
  mediaType: EvidenceAttachment["mediaType"],
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-media-"));
  const extension = mediaType === "image/png" ? "png" : mediaType === "image/gif" ? "gif" : "webm";
  const output = join(directory, `sanitized.${extension}`);
  const codecArgs = mediaType === "image/png"
    ? ["-frames:v", "1", "-f", "image2"]
    : mediaType === "image/gif"
      ? ["-an", "-f", "gif"]
      : ["-an", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-f", "webm"];
  try {
    await sandboxedFfmpeg(source, directory, `sanitized.${extension}`, codecArgs);
    return await readFile(output);
  } catch (error) {
    throw new Error(`QA attachment is not decodable ${mediaType}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function collectEvidenceAttachments(
  runDir: string,
  include: (name: string) => boolean = () => true,
): Promise<EvidenceAttachment[]> {
  await assertCanonicalDirectory(runDir);
  const names = (await readdir(runDir))
    .filter((name) => /\.(?:png|gif|webm)$/i.test(name) && include(name))
    .sort();
  const attachments: EvidenceAttachment[] = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error(`QA attachment has an unsafe filename: ${name}`);
    }
    const path = join(runDir, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > 10 * 1024 * 1024) throw new Error(`QA attachment exceeds 10 MiB: ${name}`);
    const content = await readFile(path);
    const mediaType = name.toLowerCase().endsWith(".png")
      ? "image/png"
      : name.toLowerCase().endsWith(".gif")
        ? "image/gif"
        : "video/webm";
    const valid = mediaType === "image/png"
      ? content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mediaType === "image/gif"
        ? /^(?:GIF87a|GIF89a)$/.test(content.subarray(0, 6).toString("ascii"))
        : content.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!valid) throw new Error(`QA attachment has invalid ${mediaType} signature: ${name}`);
    const sanitized = await sanitizedMedia(path, mediaType);
    if (sanitized.length > 10 * 1024 * 1024) {
      throw new Error(`Sanitized QA attachment exceeds 10 MiB: ${name}`);
    }
    totalBytes += sanitized.length;
    if (totalBytes > 25 * 1024 * 1024) throw new Error("QA attachments exceed the 25 MiB run limit");
    attachments.push({ name, content: sanitized, mediaType });
  }
  return attachments;
}

export async function collectFinalEvidenceAttachments(
  runDir: string,
): Promise<EvidenceAttachment[]> {
  return await collectEvidenceAttachments(
    runDir,
    (name) => !/^preflight(?:[._-]|$)/i.test(name),
  );
}

export async function convertWebmToGif(input: string, output: string): Promise<void> {
  await assertCanonicalDirectory(dirname(input));
  await assertCanonicalDirectory(dirname(output));
  const inputInfo = await lstat(input);
  if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) {
    throw new Error("GIF source must be a regular file, not a symlink");
  }
  const outputInfo = await lstat(output).catch(() => null);
  if (outputInfo && (!outputInfo.isFile() || outputInfo.isSymbolicLink())) {
    throw new Error("GIF destination must be a regular file, not a symlink");
  }
  const temporaryDirectory = await mkdtemp(join(dirname(output), ".pi-gif-"));
  const temporaryName = "workflow.gif";
  try {
    await sandboxedFfmpeg(input, temporaryDirectory, temporaryName, [
      "-vf",
      "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      "-an",
      "-f",
      "gif",
    ]);
    await rename(join(temporaryDirectory, temporaryName), output);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function removeExpiredEvidence(
  worktree: string,
  retentionDays: number,
  now = Date.now(),
): Promise<number> {
  const root = join(worktree, ".qa", "issues");
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  let removed = 0;

  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (!entry.isDirectory() || entry.name === "latest") continue;
      if (/^\d{8}T\d{6}Z$/.test(entry.name)) {
        const parsed = Date.parse(
          `${entry.name.slice(0, 4)}-${entry.name.slice(4, 6)}-${entry.name.slice(6, 8)}T${entry.name.slice(9, 11)}:${entry.name.slice(11, 13)}:${entry.name.slice(13, 15)}Z`,
        );
        if (Number.isFinite(parsed) && parsed < cutoff) {
          await rm(child, { recursive: true, force: true });
          removed += 1;
        }
      } else {
        await visit(child);
      }
    }
  }

  await visit(root);
  return removed;
}
