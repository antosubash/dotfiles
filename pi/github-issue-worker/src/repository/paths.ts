import { join, resolve } from "node:path";
import type { WorkerConfig } from "../config.js";
import { execFile } from "../exec.js";
import { slugify } from "../slug.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function repositoryIdentity(remote: string): string {
  let value = remote.trim();
  const scp = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  if (!value.includes("://") && !value.includes(":") && (value.startsWith("/") || value.startsWith("."))) {
    return `file://${resolve(value)}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Git remote URL: ${remote}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new Error(`Unsupported Git remote protocol: ${parsed.protocol}`);
  }
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${parsed.hostname.toLowerCase()}/${path.toLowerCase()}`;
}

export function isProtectedChange(path: string, protectedPrefixes: readonly string[]): boolean {
  const normalized = normalizePath(path);
  if (/appsettings\.secrets\.json$/i.test(normalized)) return true;
  if (/(^|\/)\.env(?:\.|$)/i.test(normalized)) return true;
  return protectedPrefixes.some((rawPrefix) => {
    const prefix = normalizePath(rawPrefix).replace(/\/$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export class BranchDivergenceError extends Error {}

export interface RepositoryContext {
  readonly config: WorkerConfig;
  readonly run: typeof execFile;
  readonly controlPath: string;
  readonly worktreesRoot: string;
}

export function branchForIssue(issueNumber: number, title: string): string {
  return `pi/issue-${issueNumber}-${slugify(title, 40)}`;
}
export function pathForIssue(worktreesRoot: string, issueNumber: number): string {
  return join(worktreesRoot, `issue-${issueNumber}`);
}
export function pathForPullRequest(worktreesRoot: string, prNumber: number): string {
  return join(worktreesRoot, `pr-${prNumber}`);
}
