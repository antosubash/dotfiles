import type { WorkerConfig } from "../config.js";
import type { GitHubIssue, GitHubPullRequest } from "../types.js";
import { commentIssue, commentPullRequest } from "./comments.js";
import type { GhRunner } from "./gh.js";

export async function ensureLabels(gh: GhRunner, config: WorkerConfig): Promise<void> {
  const labels = [
    [config.readyLabel, "1d76db", "Approved for the headless Pi worker"],
    [config.workingLabel, "fbca04", "The headless Pi worker is implementing this issue"],
    [config.pullRequestLabel, "0e8a16", "The headless Pi worker opened a draft pull request"],
    [config.blockedLabel, "d93f0b", "The headless Pi worker needs human help"],
    [config.visualLabel, "5319e7", "Capture local Playwright evidence under .qa"],
  ] as const;
  for (const [name, color, description] of labels) {
    await gh([
      "label",
      "create",
      name,
      "--repo",
      config.repository,
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
  }
}

export async function claimIssue(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
): Promise<void> {
  await gh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    config.repository,
    "--remove-label",
    config.readyLabel,
    "--remove-label",
    config.blockedLabel,
    "--add-label",
    config.workingLabel,
  ]);
  await commentIssue(
    gh,
    config,
    issueNumber,
    `🤖 Claimed. I am creating an isolated worktree from \`origin/${config.baseBranch}\` and starting implementation.`,
  );
}

export async function claimPullRequest(
  gh: GhRunner,
  config: WorkerConfig,
  pullRequest: GitHubPullRequest,
): Promise<void> {
  await gh([
    "pr",
    "edit",
    String(pullRequest.number),
    "--repo",
    config.repository,
    "--remove-label",
    config.readyLabel,
    "--remove-label",
    config.blockedLabel,
    "--add-label",
    config.workingLabel,
  ]);
  await commentPullRequest(
    gh,
    config,
    pullRequest.number,
    `🤖 Claimed existing pull request. I am creating an isolated worktree from \`origin/${pullRequest.headRefName}\` and starting automatic conflict, feedback, and CI handling.`,
  );
}

export async function activatePullRequest(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
): Promise<void> {
  await gh([
    "pr",
    "edit",
    String(prNumber),
    "--repo",
    config.repository,
    "--remove-label",
    config.readyLabel,
    "--remove-label",
    config.workingLabel,
    "--remove-label",
    config.blockedLabel,
    "--add-label",
    config.pullRequestLabel,
  ]);
}

export async function markBlocked(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
  message: string,
): Promise<void> {
  await gh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    config.repository,
    "--remove-label",
    config.readyLabel,
    "--remove-label",
    config.workingLabel,
    "--add-label",
    config.blockedLabel,
  ]);
  await commentIssue(gh, config, issueNumber, `⛔ Blocked.\n\n${message}`);
}

export async function markPullRequestOpen(
  gh: GhRunner,
  config: WorkerConfig,
  issueNumber: number,
): Promise<void> {
  await gh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    config.repository,
    "--remove-label",
    config.workingLabel,
    "--remove-label",
    config.blockedLabel,
    "--add-label",
    config.pullRequestLabel,
  ]);
}

export async function labelPullRequestFromIssue(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
  issue: GitHubIssue,
): Promise<void> {
  const transient = new Set([
    config.readyLabel.toLowerCase(),
    config.workingLabel.toLowerCase(),
    config.blockedLabel.toLowerCase(),
  ]);
  const labels = new Map<string, string>([
    [config.pullRequestLabel.toLowerCase(), config.pullRequestLabel],
  ]);
  for (const { name } of issue.labels) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || transient.has(normalized) || labels.has(normalized)) continue;
    labels.set(normalized, name);
  }
  await gh(
    [
      "api",
      "--method",
      "POST",
      `/repos/${config.repository}/issues/${prNumber}/labels`,
      "--input",
      "-",
    ],
    JSON.stringify({ labels: [...labels.values()] }),
  );
}
