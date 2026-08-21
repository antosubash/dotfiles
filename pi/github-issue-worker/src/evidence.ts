import { mkdir, readdir, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { execFile } from "./exec.js";

export interface EvidenceRun {
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
  const issueRoot = join(worktree, ".qa", "issues", String(issueNumber), `pr-${prNumber ?? "pending"}`);
  const runDir = join(issueRoot, "runs", timestamp(now));
  await mkdir(runDir, { recursive: true });
  const latest = join(issueRoot, "latest");
  await unlink(latest).catch(() => undefined);
  await symlink(relative(dirname(latest), runDir), latest, "dir");
  return { issueRoot, runDir, relativeRunDir: relative(worktree, runDir) };
}

export async function convertWebmToGif(input: string, output: string): Promise<void> {
  await execFile(
    "ffmpeg",
    [
      "-y",
      "-i",
      input,
      "-vf",
      "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      output,
    ],
    { timeoutMs: 120_000 },
  );
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
