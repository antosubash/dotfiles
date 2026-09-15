import type { WorkerConfig } from "../config.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  PullRequestInfo,
  PullRequestLifecycle,
  PullRequestMergeState,
} from "../types.js";
import { apiPages } from "./gh.js";
import type { GhRunner } from "./gh.js";

export async function listPlanningIssues(
  gh: GhRunner,
  config: WorkerConfig,
): Promise<GitHubIssue[]> {
  const output = await gh([
    "issue",
    "list",
    "--repo",
    config.repository,
    "--state",
    "open",
    "--label",
    "pi-plan",
    "--limit",
    String(config.maxIssuesPerPoll),
    "--json",
    "number,title,body,url,updatedAt,labels,author",
  ]);
  const issues = JSON.parse(output || "[]") as Array<GitHubIssue & { body: string | null }>;
  return issues.map((issue) => ({ ...issue, body: issue.body || "" }));
}

export async function listReadyIssues(gh: GhRunner, config: WorkerConfig): Promise<GitHubIssue[]> {
  const output = await gh([
    "issue",
    "list",
    "--repo",
    config.repository,
    "--state",
    "open",
    "--label",
    config.readyLabel,
    "--limit",
    String(config.maxIssuesPerPoll),
    "--json",
    "number,title,body,url,updatedAt,labels,author",
  ]);
  const issues = JSON.parse(output || "[]") as Array<GitHubIssue & { body: string | null }>;
  return issues.map((issue) => ({ ...issue, body: issue.body || "" }));
}

export async function listReadyPullRequests(
  gh: GhRunner,
  config: WorkerConfig,
): Promise<GitHubPullRequest[]> {
  const output = await gh([
    "pr",
    "list",
    "--repo",
    config.repository,
    "--state",
    "open",
    "--label",
    config.readyLabel,
    "--limit",
    String(config.maxIssuesPerPoll),
    "--json",
    "number,title,body,url,updatedAt,labels,author,headRefName,headRefOid,baseRefName,isCrossRepository",
  ]);
  const pulls = JSON.parse(output || "[]") as Array<GitHubPullRequest & { body: string | null }>;
  return pulls.map((pull) => ({ ...pull, body: pull.body || "" }));
}

export async function getPullRequest(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
): Promise<GitHubPullRequest> {
  const output = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    config.repository,
    "--json",
    "number,title,body,url,updatedAt,labels,author,headRefName,headRefOid,baseRefName,isCrossRepository",
  ]);
  const pull = JSON.parse(output) as GitHubPullRequest & { body: string | null };
  return { ...pull, body: pull.body || "" };
}

export async function getIssue(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
): Promise<GitHubIssue> {
  const output = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    config.repository,
    "--json",
    "number,title,body,url,updatedAt,labels,author",
  ]);
  const issue = JSON.parse(output) as GitHubIssue & { body: string | null };
  return { ...issue, body: issue.body || "" };
}

export async function findOpenPullRequest(
  gh: GhRunner,
  config: WorkerConfig,
  branch: string,
): Promise<PullRequestInfo | null> {
  const output = await gh([
    "pr",
    "list",
    "--repo",
    config.repository,
    "--state",
    "open",
    "--head",
    branch,
    "--json",
    "number,url",
    "--limit",
    "1",
  ]);
  const pulls = JSON.parse(output || "[]") as PullRequestInfo[];
  return pulls[0] ?? null;
}

export async function findOpenPullRequestsForIssue(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
  excludedBranch: string,
): Promise<PullRequestInfo[]> {
  const pulls = await apiPages<{
    number: number;
    html_url: string;
    head: { ref: string };
    title: string;
    body: string | null;
  }>(gh, `/repos/${config.repository}/pulls?state=open&per_page=100`);
  const reference = new RegExp(`(^|[^0-9])#${issueNumber}(?![0-9])`);
  return pulls
    .filter(
      (pull) =>
        pull.head.ref !== excludedBranch &&
        reference.test(`${pull.title}\n${pull.body || ""}`),
    )
    .map(({ number, html_url: url }) => ({ number, url }));
}

export async function createDraftPullRequest(
  gh: GhRunner,
  config: WorkerConfig,
  branch: string,
  title: string,
  body: string,
): Promise<PullRequestInfo> {
  const url = await gh(
    [
      "pr",
      "create",
      "--repo",
      config.repository,
      "--draft",
      "--base",
      config.baseBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      "-",
    ],
    body,
  );
  const match = url.match(/\/pull\/(\d+)/);
  if (!match?.[1]) throw new Error(`Could not parse pull request URL: ${url}`);
  return { number: Number.parseInt(match[1], 10), url };
}

export async function isPullRequestOpen(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
): Promise<boolean> {
  const state = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    config.repository,
    "--json",
    "state",
    "--jq",
    ".state",
  ]);
  return state === "OPEN";
}

export async function getPullRequestLifecycle(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
): Promise<PullRequestLifecycle> {
  const output = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    config.repository,
    "--json",
    "state,mergedAt,headRefOid",
  ]);
  const lifecycle = JSON.parse(output) as {
    state: PullRequestLifecycle["state"];
    mergedAt: string | null;
    headRefOid: string;
  };
  return {
    state: lifecycle.state,
    mergedAt: lifecycle.mergedAt,
    headSha: lifecycle.headRefOid,
  };
}

async function getBranchRevision(
  gh: GhRunner,
  config: WorkerConfig,
  branch: string,
): Promise<string> {
  const branchPath = branch.split("/").map(encodeURIComponent).join("/");
  const output = await gh(["api", `/repos/${config.repository}/git/ref/heads/${branchPath}`]);
  const ref = JSON.parse(output) as { object?: { sha?: unknown; type?: unknown } };
  if (
    typeof ref.object?.sha !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(ref.object.sha) ||
    ref.object.type !== "commit"
  ) {
    throw new Error(`GitHub returned an invalid target for base branch ${branch}`);
  }
  return ref.object.sha;
}

export async function getPullRequestMergeState(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
): Promise<PullRequestMergeState> {
  const output = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    config.repository,
    "--json",
    "baseRefName,baseRefOid,headRefOid,mergeable,mergeStateStatus",
  ]);
  const state = JSON.parse(output) as {
    baseRefName: string;
    headRefOid: string;
    mergeable: PullRequestMergeState["mergeable"];
    mergeStateStatus: string;
  };
  return {
    headSha: state.headRefOid,
    // GitHub's PR baseRefOid is frozen until the PR updates; resolve the live branch ref independently.
    baseSha: await getBranchRevision(gh, config, state.baseRefName),
    baseBranch: state.baseRefName,
    mergeable: state.mergeable,
    mergeStateStatus: state.mergeStateStatus,
  };
}
