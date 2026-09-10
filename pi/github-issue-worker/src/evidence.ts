import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { assertCanonicalDirectory, sanitizedMedia, type MediaType } from "./media.js";

export { convertWebmToGif } from "./media.js";

export interface EvidenceAttachment {
  name: string;
  content: Buffer;
  mediaType: MediaType;
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

export type EvidenceSkip = (name: string, reason: string) => void;

const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const RUN_LIMIT = 25 * 1024 * 1024;

/**
 * PNG screenshots are the evidence the gate validates, so their limits fail the run. A workflow GIF or
 * WebM is supporting material: when it breaches a limit it is skipped and reported instead.
 */
export async function collectEvidenceAttachments(
  runDir: string,
  options: { include?: (name: string) => boolean; onSkip?: EvidenceSkip } = {},
): Promise<EvidenceAttachment[]> {
  const include = options.include ?? (() => true);
  const onSkip = options.onSkip ?? (() => {});
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
    const mediaType = name.toLowerCase().endsWith(".png")
      ? "image/png"
      : name.toLowerCase().endsWith(".gif")
        ? "image/gif"
        : "video/webm";
    const optional = mediaType !== "image/png";
    // PNG screenshots are what the gate validates, so any defect fails the run; a GIF/WebM is
    // supporting material, so every defect here (oversized, corrupt, or over the run budget) is
    // skipped and reported instead of blocking otherwise-valid PNG evidence.
    const skippable = (message: string): boolean => {
      if (!optional) throw new Error(message);
      onSkip(name, message);
      return true;
    };
    if (info.size > ATTACHMENT_LIMIT && skippable(`QA attachment exceeds 10 MiB: ${name}`)) continue;
    const content = await readFile(path);
    const valid = mediaType === "image/png"
      ? content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mediaType === "image/gif"
        ? /^(?:GIF87a|GIF89a)$/.test(content.subarray(0, 6).toString("ascii"))
        : content.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!valid && skippable(`QA attachment has invalid ${mediaType} signature: ${name}`)) continue;
    let sanitized: Buffer;
    try {
      sanitized = await sanitizedMedia(path, mediaType);
    } catch (error) {
      skippable(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (sanitized.length > ATTACHMENT_LIMIT && skippable(`Sanitized QA attachment exceeds 10 MiB: ${name}`)) continue;
    if (totalBytes + sanitized.length > RUN_LIMIT && skippable(`QA attachments exceed the 25 MiB run limit: ${name}`)) continue;
    totalBytes += sanitized.length;
    attachments.push({ name, content: sanitized, mediaType });
  }
  return attachments;
}

export async function collectFinalEvidenceAttachments(
  runDir: string,
  onSkip?: EvidenceSkip,
): Promise<EvidenceAttachment[]> {
  return await collectEvidenceAttachments(runDir, {
    include: (name) => !/^preflight(?:[._-]|$)/i.test(name),
    ...(onSkip ? { onSkip } : {}),
  });
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
