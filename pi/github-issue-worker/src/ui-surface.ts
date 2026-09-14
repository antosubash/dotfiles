import { execFile } from "./exec.js";
import type { GitHubIssue } from "./types.js";

const UI_SURFACE =
  /\b(?:ui|ux|frontend|front-end|layout|responsive|browser|figma|page|screen|form|button|dialog|modal|component)\b|(?:^|\/)(?:app|frontend|client|views?|routes?|pages?|components?|templates?|static|ui)\/|\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)\b/im;

/** The one heuristic the verifier and the stage wrapper share, so both agree on whether a browser stage is needed. */
export function isUiSurface(issue: Pick<GitHubIssue, "title" | "body">, changedPaths: string, untrackedPaths: string): boolean {
  return UI_SURFACE.test(`${issue.title}\n${issue.body}\n${changedPaths}\n${untrackedPaths}`);
}

/** `isUiSurface` over the worktree's diff against the base branch plus its untracked files. */
export async function worktreeUiSurface(issue: Pick<GitHubIssue, "title" | "body">, worktree: string, baseBranch: string): Promise<boolean> {
  const changed = (await execFile("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", `origin/${baseBranch}`], { cwd: worktree })).stdout;
  const untracked = (await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree })).stdout;
  return isUiSurface(issue, changed, untracked);
}
