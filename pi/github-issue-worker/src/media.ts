import { lstat, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "./exec.js";

export type MediaType = "image/png" | "image/gif" | "video/webm";

export async function assertCanonicalDirectory(path: string): Promise<void> {
  const canonical = await realpath(path);
  const info = await lstat(path);
  if (canonical !== resolve(path) || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`QA evidence directory contains a symlink: ${path}`);
  }
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

export async function sanitizedMedia(source: string, mediaType: MediaType): Promise<Buffer> {
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
