import { join } from "node:path";
import { classifyIssue } from "../classification.js";
import type { EvidenceRun } from "../evidence.js";
import { memoryDirectory, projectMemoryIndex } from "../project-memory.js";
import { buildIssuePrompt } from "../prompts.js";
import type { QaManifest } from "../qa-manifest.js";
import type { GitHubIssue, IssueJob } from "../types.js";
import { createTrackedEvidence, visualEvidenceNote } from "./evidence-flow.js";
import { errorText, isBlockedFinalOutput, type WorkerContext } from "./shared.js";

export interface ImplementerRun {
  finalText: string;
  /** The evidence run the implementer captured into, when it captured during implementation. */
  evidence: EvidenceRun | null;
}

/**
 * The implementer's main run. It captures visual evidence during implementation only when the agent
 * also launches the app; with a manifest `launch` the controller owns the instance and capture moves to
 * the dedicated visual stage, so the implementer only implements.
 */
export async function runImplementer(
  ctx: WorkerContext,
  issue: GitHubIssue,
  job: IssueJob,
  worktree: { path: string; branch: string },
  options: { visual: boolean; manifest: QaManifest | null },
): Promise<ImplementerRun> {
  const capturesDuringImplementation = options.visual && !options.manifest?.launch;
  const evidence = capturesDuringImplementation
    ? await createTrackedEvidence(ctx, worktree.path, issue.number, null)
    : null;
  const noteFor = async (text: string): Promise<string> =>
    `${text}${await visualEvidenceNote(evidence?.runDir ?? null, evidence?.relativeRunDir ?? null)}`;
  let result;
  try {
    result = await ctx.agent.run({
      worktree: worktree.path,
      sessionDir: join(ctx.config.dataDir, "sessions", `issue-${issue.number}`),
      sessionFile: job.sessionFile,
      prompt: buildIssuePrompt({
        config: ctx.config,
        issue,
        evidenceDir: evidence?.relativeRunDir ?? null,
        qaManifest: options.manifest,
        category: classifyIssue(issue),
        plan: await ctx.plans.load(issue),
        memory: await projectMemoryIndex(memoryDirectory(ctx.config)),
      }),
      logFile: join(ctx.config.dataDir, "logs", `issue-${issue.number}.log`),
      visualVerification: evidence !== null,
      dockerAccess: ctx.config.allowDocker,
    });
  } catch (error) {
    if (evidence) {
      ctx.state.setEvidenceRunStatus(evidence.issueNumber, evidence.prNumber, evidence.runId, "invalid-terminal", errorText(error));
    }
    await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
    throw new Error(await noteFor(errorText(error)));
  }
  ctx.state.setSession(issue.number, result.sessionFile);
  if (isBlockedFinalOutput(result.finalText)) {
    if (evidence) {
      ctx.state.setEvidenceRunStatus(evidence.issueNumber, evidence.prNumber, evidence.runId, "blocked", result.finalText);
    }
    await ctx.repository.clearAgentChanges(worktree.path, worktree.branch);
    throw new Error(await noteFor(result.finalText));
  }
  return { finalText: result.finalText, evidence };
}
