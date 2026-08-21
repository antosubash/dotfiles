import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface WorkerConfig {
  repository: string;
  repositoryUrl: string;
  baseBranch: string;
  labelPrefix: string;
  readyLabel: string;
  workingLabel: string;
  pullRequestLabel: string;
  blockedLabel: string;
  visualLabel: string;
  dataDir: string;
  pollSeconds: number;
  maxIssuesPerPoll: number;
  thinkingLevel: ThinkingLevel;
  trustedAssociations: ReadonlySet<string>;
  protectedPaths: readonly string[];
  appUrl: string | null;
  playwrightState: string | null;
  qaRetentionDays: number;
  agentDir: string;
}

function expandPath(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function positiveInteger(name: string, value: string, fallback: number): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const repository = env.PI_WORKER_REPOSITORY?.trim();
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("PI_WORKER_REPOSITORY is required and must use owner/repository format");
  }
  const repositoryUrl =
    env.PI_WORKER_REPOSITORY_URL?.trim() || `https://github.com/${repository}.git`;
  const baseBranch = env.PI_WORKER_BASE_BRANCH?.trim();
  if (!baseBranch) throw new Error("PI_WORKER_BASE_BRANCH is required");
  const thinking = env.PI_WORKER_THINKING_LEVEL?.trim() || "high";
  if (!THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
    throw new Error(`PI_WORKER_THINKING_LEVEL is invalid: ${thinking}`);
  }

  const associations = (env.PI_WORKER_TRUSTED_ASSOCIATIONS || "OWNER,MEMBER,COLLABORATOR")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (associations.length === 0) {
    throw new Error("PI_WORKER_TRUSTED_ASSOCIATIONS must not be empty");
  }

  const home = env.HOME || homedir();
  const appUrl = env.PI_WORKER_APP_URL?.trim() || null;
  const statePath = env.PI_WORKER_PLAYWRIGHT_STATE?.trim();
  const labelPrefix = env.PI_WORKER_LABEL_PREFIX?.trim() || "pi";
  const repositorySlug = repository.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const protectedPaths = (env.PI_WORKER_PROTECTED_PATHS || ".git,.github/workflows,.pi")
    .split(",")
    .map((value) => value.trim().replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);

  return {
    repository,
    repositoryUrl,
    baseBranch,
    labelPrefix,
    readyLabel: env.PI_WORKER_READY_LABEL?.trim() || `${labelPrefix}-ready`,
    workingLabel: `${labelPrefix}-working`,
    pullRequestLabel: `${labelPrefix}-pr-open`,
    blockedLabel: `${labelPrefix}-blocked`,
    visualLabel: env.PI_WORKER_VISUAL_LABEL?.trim() || `${labelPrefix}-visual`,
    dataDir: expandPath(
      env.PI_WORKER_DATA_DIR?.trim() || `~/.local/share/pi-issue-worker/${repositorySlug}`,
      home,
    ),
    pollSeconds: positiveInteger("PI_WORKER_POLL_SECONDS", env.PI_WORKER_POLL_SECONDS || "", 60),
    maxIssuesPerPoll: positiveInteger(
      "PI_WORKER_MAX_ISSUES_PER_POLL",
      env.PI_WORKER_MAX_ISSUES_PER_POLL || "",
      1,
    ),
    thinkingLevel: thinking as ThinkingLevel,
    trustedAssociations: new Set(associations),
    protectedPaths,
    appUrl,
    playwrightState: statePath ? expandPath(statePath, home) : null,
    qaRetentionDays: positiveInteger(
      "PI_WORKER_QA_RETENTION_DAYS",
      env.PI_WORKER_QA_RETENTION_DAYS || "",
      14,
    ),
    agentDir: expandPath(env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent", home),
  };
}
