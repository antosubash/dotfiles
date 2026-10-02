import { execFile } from "./exec.js";
import type { GitHubIssue } from "./types.js";

const UI_WORDS =
  /\b(?:ui|ux|frontend|front-end|layout|responsive|browser|figma|page|screen|form|button|dialog|modal|component)\b/im;
const UI_PATHS =
  /(?:^|\/)(?:app|frontend|client|views?|routes?|pages?|components?|templates?|static|ui)\/|\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)\b/im;

/** The one heuristic the verifier and the stage wrapper share, so both agree on whether a browser stage is needed. */
export function isUiSurface(issue: Pick<GitHubIssue, "title" | "body">, changedPaths: string, untrackedPaths: string): boolean {
  const text = `${issue.title}\n${issue.body}\n${changedPaths}\n${untrackedPaths}`;
  return UI_WORDS.test(text) || UI_PATHS.test(text);
}

/**
 * Whether the change itself touches UI files — paths only, never the issue's prose. Issue wording is a
 * hint (it decides whether a browser is offered); it must not turn a backend-only diff into a run that
 * cannot pass without screenshots. "page" in a backend bug report is the common false positive.
 */
export function diffTouchesUi(changedPaths: string, untrackedPaths: string): boolean {
  return UI_PATHS.test(`${changedPaths}\n${untrackedPaths}`);
}

async function worktreePaths(worktree: string, baseBranch: string): Promise<{ changed: string; untracked: string }> {
  const changed = (await execFile("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", `origin/${baseBranch}`], { cwd: worktree })).stdout;
  const untracked = (await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree })).stdout;
  return { changed, untracked };
}

/** `isUiSurface` over the worktree's diff against the base branch plus its untracked files. */
export async function worktreeUiSurface(issue: Pick<GitHubIssue, "title" | "body">, worktree: string, baseBranch: string): Promise<boolean> {
  const { changed, untracked } = await worktreePaths(worktree, baseBranch);
  return isUiSurface(issue, changed, untracked);
}

/** `diffTouchesUi` over the worktree's diff against the base branch plus its untracked files. */
export async function worktreeDiffTouchesUi(worktree: string, baseBranch: string): Promise<boolean> {
  const { changed, untracked } = await worktreePaths(worktree, baseBranch);
  return diffTouchesUi(changed, untracked);
}
