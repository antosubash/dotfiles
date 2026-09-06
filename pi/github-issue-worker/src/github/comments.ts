import type { WorkerConfig } from "../config.js";
import type { PullRequestFeedback } from "../types.js";
import { apiPages } from "./gh.js";
import type { GhRunner } from "./gh.js";

const WORKER_MARKER = "<!-- pi-issue-worker -->";

interface RawFeedback {
  id: number;
  body: string | null;
  html_url?: string;
  created_at?: string;
  submitted_at?: string;
  author_association?: string;
  user?: { login?: string };
}

export async function commentIssue(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
  body: string,
): Promise<void> {
  await gh(
    [
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      config.repository,
      "--body-file",
      "-",
    ],
    `${WORKER_MARKER}\n${body}\n`,
  );
}

export async function commentPullRequest(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
  body: string,
): Promise<void> {
  await gh(
    [
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      config.repository,
      "--body-file",
      "-",
    ],
    `${WORKER_MARKER}\n${body}\n`,
  );
}

export async function hasPullRequestCommentMarker(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
  marker: string,
): Promise<boolean> {
  const output = await gh([
    "api",
    "--paginate",
    `/repos/${config.repository}/issues/${prNumber}/comments?per_page=100`,
    "--jq",
    ".[].body // empty",
  ]);
  return output.includes(marker);
}

export async function listIssueCommands(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
): Promise<PullRequestFeedback[]> {
  const items = await apiPages<RawFeedback>(
    gh,
    `/repos/${config.repository}/issues/${issueNumber}/comments`,
  );
  return items
    .map((item) => mapFeedback(item, "conversation"))
    .filter((item): item is PullRequestFeedback => item !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function listFeedback(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
): Promise<PullRequestFeedback[]> {
  const base = `/repos/${config.repository}`;
  const sources = await Promise.all([
    apiPages<RawFeedback>(gh, `${base}/issues/${prNumber}/comments`).then((items) =>
      items.map((item) => mapFeedback(item, "conversation")),
    ),
    apiPages<RawFeedback>(gh, `${base}/pulls/${prNumber}/reviews`).then((items) =>
      items.map((item) => mapFeedback(item, "review")),
    ),
    apiPages<RawFeedback>(gh, `${base}/pulls/${prNumber}/comments`).then((items) =>
      items.map((item) => mapFeedback(item, "review_comment")),
    ),
  ]);
  return sources
    .flat()
    .filter((item): item is PullRequestFeedback => item !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function mapFeedback(
  item: RawFeedback,
  source: PullRequestFeedback["source"],
): PullRequestFeedback | null {
  const rawBody = item.body?.trim();
  if (!rawBody || rawBody.includes(WORKER_MARKER)) return null;
  const body = rawBody.length > 20_000 ? `${rawBody.slice(0, 20_000)}\n…truncated` : rawBody;
  return {
    eventKey: `${source}:${item.id}`,
    source,
    id: item.id,
    body,
    author: item.user?.login || "unknown",
    authorAssociation: (item.author_association || "NONE").toUpperCase(),
    createdAt: item.submitted_at || item.created_at || new Date(0).toISOString(),
    url: item.html_url || null,
  };
}

export function isActionableFeedback(
  feedback: PullRequestFeedback,
  trustedAssociations: ReadonlySet<string>,
): boolean {
  if (!trustedAssociations.has(feedback.authorAssociation)) return false;
  if (feedback.source === "conversation") return /^\/pi(?:\s|$)/i.test(feedback.body);
  return true;
}

export function parseWorkerCommand(body: string): string | null {
  const match = body.trim().match(/^\/pi(?:\s+([^\n]+))?/i);
  return match ? (match[1]?.trim().toLowerCase() || "help") : null;
}
