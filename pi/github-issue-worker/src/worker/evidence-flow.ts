import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  collectFinalEvidenceAttachments,
  convertWebmToGif,
  createEvidenceRun,
  type EvidenceRun,
} from "../evidence.js";
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
): Promise<EvidenceRun> {
  ctx.state.requestVisualEvidence(job.issueNumber);
  const evidence = await createTrackedEvidence(ctx, worktree, job.issueNumber, prNumber);
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
      }),
      logFile: join(ctx.config.dataDir, "logs", `issue-${job.issueNumber}.log`),
      visualVerification: true,
      dockerAccess: ctx.config.allowDocker,
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

export async function finalizeEvidence(ctx: WorkerContext, evidence: EvidenceRun | null): Promise<void> {
  if (!evidence) return;
  try {
    await finishRequestedGif(evidence.runDir);
    const attachments = await collectFinalEvidenceAttachments(evidence.runDir);
    if (!attachments.some((item) => item.mediaType === "image/png")) {
      throw new Error("Visual QA produced no PNG screenshot");
    }
    if (!attachments.some((item) => item.mediaType === "image/gif")) {
      throw new Error("Visual QA produced no workflow GIF");
    }
    ctx.state.recordEvidenceRun(
      evidence.issueNumber,
      evidence.prNumber,
      evidence.runId,
      "valid",
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
  const attachments = await collectFinalEvidenceAttachments(evidence.runDir);
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
  return { note, eventKey };
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
