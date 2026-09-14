import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppInstance } from "../app-instance/index.js";
import {
  collectFinalEvidenceAttachments,
  convertWebmToGif,
  createEvidenceRun,
  type EvidenceAttachment,
  type EvidenceRun,
} from "../evidence.js";
import type { MediaType } from "../media.js";
import { memoryDirectory, projectMemoryIndex } from "../project-memory.js";
import { buildUiVerificationPrompt } from "../prompts.js";
import { loadQaManifest } from "../qa-manifest.js";
import type { IssueJob } from "../types.js";
import {
  errorText,
  evidenceCommentMarker,
  isBlockedFinalOutput,
  type WorkerContext,
} from "./shared.js";

export async function finishRequestedGif(runDir: string | null): Promise<boolean> {
  if (!runDir) return false;
  const webm = join(runDir, "workflow.webm");
  const gif = join(runDir, "workflow.gif");
  const webmInfo = await lstat(webm).catch(() => null);
  if (!webmInfo) return false;
  if (!webmInfo.isFile() || webmInfo.isSymbolicLink()) {
    throw new Error("workflow.webm must be a regular file, not a symlink");
  }
  const gifInfo = await lstat(gif).catch(() => null);
  if (gifInfo && (!gifInfo.isFile() || gifInfo.isSymbolicLink())) {
    throw new Error("workflow.gif must be a regular file, not a symlink");
  }
  await convertWebmToGif(webm, gif);
  return true;
}

export async function visualEvidenceNote(
  runDir: string | null,
  relativeRunDir: string | null,
): Promise<string> {
  if (!runDir || !relativeRunDir) return "";
  const artifacts = (await readdir(runDir).catch(() => []))
    .filter((name) => /\.(?:png|gif|webm|md|txt)$/i.test(name))
    .sort();
  if (artifacts.length === 0) {
    return `\n\nVisual evidence directory (local, ignored): \`${relativeRunDir}\` (no capture artifact was produced).`;
  }
  return `\n\nVisual evidence captured locally under ignored \`${relativeRunDir}\`:\n${artifacts.map((name) => `- \`${name}\``).join("\n")}`;
}

export async function createTrackedEvidence(
  ctx: WorkerContext,
  worktree: string,
  issueNumber: number,
  prNumber: number | null,
): Promise<EvidenceRun> {
  const evidence = await createEvidenceRun(worktree, issueNumber, prNumber);
  ctx.state.recordEvidenceRun(issueNumber, prNumber, evidence.runId);
  return evidence;
}

export async function runUiVerification(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: string,
  prNumber: number | null,
  instance: AppInstance | null = null,
): Promise<EvidenceRun> {
  ctx.state.requestVisualEvidence(job.issueNumber);
  const evidence = await createTrackedEvidence(ctx, worktree, job.issueNumber, prNumber);
  await instance?.ensureCurrent();
  let result;
  try {
    result = await ctx.agent.run({
      worktree,
      sessionDir: join(ctx.config.dataDir, "sessions", `issue-${job.issueNumber}`),
      sessionFile: job.sessionFile,
      prompt: buildUiVerificationPrompt({
        config: ctx.config,
        issueNumber: job.issueNumber,
        prNumber,
        evidenceDir: evidence.relativeRunDir,
        qaManifest: await loadQaManifest(worktree, ctx.config.qaManifestPath),
        instance,
        memory: await projectMemoryIndex(memoryDirectory(ctx.config)),
      }),
      logFile: join(ctx.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
      visualVerification: true,
      dockerAccess: ctx.config.allowDocker,
      ...(instance ? { environment: instance.environment() } : {}),
    });
  } catch (error) {
    ctx.state.setEvidenceRunStatus(
      evidence.issueNumber,
      evidence.prNumber,
      evidence.runId,
      "invalid-terminal",
      errorText(error),
    );
    throw error;
  }
  ctx.state.setSession(job.issueNumber, result.sessionFile);
  if (isBlockedFinalOutput(result.finalText)) {
    ctx.state.setEvidenceRunStatus(
      evidence.issueNumber,
      evidence.prNumber,
      evidence.runId,
      "blocked",
      result.finalText,
    );
    throw new Error(result.finalText);
  }
  await finalizeEvidence(ctx, evidence);
  return evidence;
}

/**
 * PNG screenshots are mandatory: they are what the gate validates. The workflow GIF is supporting
 * material, so a missing or oversized one is reported in the PR note rather than blocking the run.
 */
async function finalAttachments(runDir: string): Promise<{ attachments: EvidenceAttachment[]; omitted: string[] }> {
  const skipped: Array<{ name: string; mediaType: MediaType; reason: string }> = [];
  const attachments = await collectFinalEvidenceAttachments(runDir, (skip) => skipped.push(skip));
  const omitted = skipped.map(({ name, reason }) => `\`${name}\` — ${reason}`);
  // Both lists carry the media type evidence collection assigned, so nothing here re-classifies by name.
  const isGif = (item: { mediaType: MediaType }) => item.mediaType === "image/gif";
  if (!attachments.some(isGif) && !skipped.some(isGif)) omitted.push("workflow GIF was not produced");
  return { attachments, omitted };
}

function omissionNote(omitted: string[]): string {
  return omitted.length === 0 ? "" : `\n\nOmitted evidence:\n${omitted.map((entry) => `- ${entry}`).join("\n")}`;
}

export async function finalizeEvidence(ctx: WorkerContext, evidence: EvidenceRun | null): Promise<void> {
  if (!evidence) return;
  try {
    await finishRequestedGif(evidence.runDir);
    const { attachments, omitted } = await finalAttachments(evidence.runDir);
    if (!attachments.some((item) => item.mediaType === "image/png")) {
      throw new Error("Visual QA produced no PNG screenshot");
    }
    ctx.state.recordEvidenceRun(
      evidence.issueNumber,
      evidence.prNumber,
      evidence.runId,
      "valid",
      omitted.length > 0 ? omissionNote(omitted).trim() : undefined,
    );
  } catch (error) {
    const report = await readFile(join(evidence.runDir, "report.md"), "utf8").catch(() => "");
    const blocked = /(?:^|\n)(?:##\s+Status\s*\n+)?\s*Blocked\s*:/i.test(report);
    const detail = blocked && report.trim()
      ? `Visual QA blocked.\n\n${report.trim().slice(0, 1_500)}`
      : errorText(error);
    ctx.state.recordEvidenceRun(
      evidence.issueNumber,
      evidence.prNumber,
      evidence.runId,
      blocked ? "blocked" : "invalid-terminal",
      detail,
    );
    throw new Error(detail);
  }
}

export async function publishEvidence(
  ctx: WorkerContext,
  prNumber: number,
  worktree: string,
  evidence: EvidenceRun | null,
): Promise<{ note: string; eventKey: string } | null> {
  if (!evidence || typeof ctx.github.publishEvidence !== "function") return null;
  await finalizeEvidence(ctx, evidence);
  const { attachments, omitted } = await finalAttachments(evidence.runDir);
  if (attachments.length === 0) return null;
  const runId = basename(evidence.runDir);
  const eventKey = `evidence:${prNumber}:${runId}`;
  const headSha = await ctx.repository.headRevision(worktree);
  const note = await ctx.github.publishEvidence(prNumber, headSha, runId, attachments);
  ctx.state.setEvidenceRunStatus(
    evidence.issueNumber,
    evidence.prNumber,
    evidence.runId,
    "published",
    note || "Evidence publication is disabled",
  );
  if (!note) {
    ctx.state.markProcessed(evidence.issueNumber, eventKey);
    return null;
  }
  return { note: `${note}${omissionNote(omitted)}`, eventKey };
}

export async function publishBlockedEvidence(
  ctx: WorkerContext,
  job: IssueJob,
  worktree: string,
  evidence: EvidenceRun | null,
): Promise<string> {
  try {
    const published = await publishEvidence(ctx, job.prNumber!, worktree, evidence);
    if (!published) return "";
    return `\n${evidenceCommentMarker(published.eventKey)}${published.note}`;
  } catch (error) {
    return `\n\nQA evidence upload failed: ${errorText(error)}`;
  }
}

/**
 * Publishes PNG/GIF/WebM attachments from any evidence directory — the independent verifier's, in
 * particular — with the same sanitising and limits as a `.qa` run; there is no evidence-run record for it.
 */
export async function publishEvidenceDirectory(
  ctx: WorkerContext,
  prNumber: number,
  worktree: string,
  directory: string,
  runId: string,
): Promise<{ note: string; eventKey: string } | null> {
  if (typeof ctx.github.publishEvidence !== "function") return null;
  const { attachments, omitted } = await finalAttachments(directory);
  if (attachments.length === 0) return null;
  const eventKey = `evidence:${prNumber}:${runId}`;
  const note = await ctx.github.publishEvidence(prNumber, await ctx.repository.headRevision(worktree), runId, attachments);
  return note ? { note: `${note}${omissionNote(omitted)}`, eventKey } : null;
}
