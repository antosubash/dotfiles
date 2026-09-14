import type { AppInstanceService } from "../app-instance/index.js";
import type { WorkerConfig } from "../config.js";
import type { FigmaVerificationService } from "../figma-verification.js";
import type { GitHubClient } from "../github.js";
import type { IssuePlanService } from "../issue-plan.js";
import type { PiAgentRunner } from "../pi-agent.js";
import type { QaVerificationService } from "../qa-verification.js";
import type { RepositoryManager } from "../repository.js";
import type { WorkerState } from "../state.js";
import type { GitHubIssue } from "../types.js";

export interface WorkerContext {
  readonly config: WorkerConfig;
  readonly state: WorkerState;
  readonly github: GitHubClient;
  readonly repository: RepositoryManager;
  readonly agent: PiAgentRunner;
  readonly designVerifier: Pick<FigmaVerificationService, "verify">;
  readonly qaVerifier: Pick<QaVerificationService, "verify">;
  readonly plans: Pick<IssuePlanService, "load" | "create">;
  /** Launches the manifest-declared app once per run; tests replace `start`. */
  readonly appInstances: Pick<AppInstanceService, "start">;
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message;
}

export class RetryableControllerError extends Error {}

export const CONFLICT_BLOCK_PREFIX = "Automatic base-branch conflict resolution failed:";

export function isInterruptedRun(error: unknown): boolean {
  return /(?:^|\b)(?:aborted|sigint|sigterm|shutdown|terminated by signal)(?:\b|$)/i.test(
    errorText(error),
  );
}

export function looksLikeUiTask(text: string): boolean {
  return /\b(?:ui|ux|frontend|front-end|page|screen|form|button|dialog|modal|toast|layout|responsive|mobile|desktop|visual|browser|playwright|component|tsx|jsx|css|html|invite|settings)\b/i.test(text);
}

export function containsUiFiles(paths: readonly string[]): boolean {
  return paths.some((path) =>
    /(?:^|\/)(?:app|frontend|client|views?|routes?|pages?|components?|templates?|static|ui)(?:\/|$)|(?:^|\/)src\/.*\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx|css|scss|sass|less|html)$|\.(?:tsx|jsx|vue|svelte|astro|mdx|css|scss|sass|less|html)$/i.test(path),
  );
}

export function evidenceRequested(issue: GitHubIssue, visualLabel: string): boolean {
  return issue.labels.some((label) => label.name.toLowerCase() === visualLabel.toLowerCase());
}

export function evidenceCommentMarker(eventKey: string): string {
  return `<!-- pi-worker-${eventKey} -->`;
}

export function markdownSummary(text: string, maximum = 5_000): string {
  if (!text) return "Pi returned no textual summary.";
  return text.length > maximum ? `${text.slice(0, maximum)}\n\n…truncated` : text;
}

export function isBlockedFinalOutput(text: string): boolean {
  return /^\s*(?:[#>*-]\s*)*(?:\*\*|__)?BLOCKED\b/im.test(text);
}
