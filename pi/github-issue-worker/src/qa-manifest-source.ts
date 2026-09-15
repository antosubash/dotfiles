import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "./config.js";
import { memoryDirectory, PRIVATE_QA_MANIFEST_FILE } from "./project-memory.js";
import { loadQaManifest, MAX_MANIFEST_BYTES, parseManifest, type QaManifest } from "./qa-manifest.js";

/**
 * The QA manifest is operator configuration for one repository, and it stays with the operator: the
 * private copy in the profile's memory directory is read first, so nothing about how the worker launches,
 * probes or logs in to a repository's stack has to be committed to that repository. The repository's own
 * `.pi-worker/qa.json` remains a fallback for profiles that keep it there.
 */
export function privateQaManifestPath(config: Pick<WorkerConfig, "dataDir">): string {
  return join(memoryDirectory(config), PRIVATE_QA_MANIFEST_FILE);
}

/** Reads and validates the private manifest; null when there is none. A malformed file fails closed. */
export async function loadPrivateQaManifest(path: string): Promise<QaManifest | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`private QA manifest must be a regular file: ${path}`);
  if (info.size > MAX_MANIFEST_BYTES) throw new Error(`private QA manifest exceeds 64 KiB: ${path}`);
  // The harness executes launch.argv from this file; it must not be writable by anyone but the operator.
  if ((info.mode & 0o022) !== 0) throw new Error(`private QA manifest must not be group/world writable: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`private QA manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(raw);
}

export async function loadWorkerQaManifest(
  config: Pick<WorkerConfig, "dataDir" | "qaManifestPath">,
  worktree: string,
): Promise<QaManifest | null> {
  return (await loadPrivateQaManifest(privateQaManifestPath(config))) ?? await loadQaManifest(worktree, config.qaManifestPath);
}
