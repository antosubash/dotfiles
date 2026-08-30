import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { safeRepositoryPath } from "./qa-manifest.js";

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
  maxCiFixAttempts: number;
  agentTimeoutMinutes: number;
  thinkingLevel: ThinkingLevel;
  model: string;
  trustedAssociations: ReadonlySet<string>;
  protectedPaths: readonly string[];
  appUrl: string | null;
  playwrightState: string | null;
  qaRetentionDays: number;
  agentDir: string;
  sandboxAllowedDomains: readonly string[];
  allowDocker: boolean;
  dockerSocket: string | null;
  publishEvidence: boolean;
  evidenceBranch: string;
  qaManifestPath: string;
}

function expandPath(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function booleanFlag(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || ["0", "false", "no"].includes(normalized)) return false;
  if (["1", "true", "yes"].includes(normalized)) return true;
  throw new Error(`${name} must be 1/true/yes or 0/false/no`);
}

function positiveInteger(name: string, value: string, fallback: number): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boundedPositiveInteger(
  name: string,
  value: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = positiveInteger(name, value, fallback);
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}`);
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
  const appHost = appUrl ? new URL(appUrl).hostname : null;
  const sandboxAllowedDomains = [
    "npmjs.org",
    "*.npmjs.org",
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "github.com",
    "*.github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "localhost",
    "127.0.0.1",
    ...(appHost ? [appHost] : []),
    ...(env.PI_WORKER_SANDBOX_ALLOWED_DOMAINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  const statePath = env.PI_WORKER_PLAYWRIGHT_STATE?.trim();
  const model = env.PI_WORKER_MODEL?.trim() || "openai-codex/gpt-5.6-terra";
  if (!/^[^/\s]+\/[^/\s]+$/.test(model)) {
    throw new Error("PI_WORKER_MODEL must use provider/model format");
  }
  const labelPrefix = env.PI_WORKER_LABEL_PREFIX?.trim() || "pi";
  const repositorySlug = repository.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const repositoryIdentityHash = createHash("sha256")
    .update(`${repository}\n${repositoryUrl}`)
    .digest("hex")
    .slice(0, 12);
  const protectedPaths = (env.PI_WORKER_PROTECTED_PATHS || ".git,.github/workflows,.pi,.pi-worker")
    .split(",")
    .map((value) => value.trim().replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  const explicitDataDir = env.PI_WORKER_DATA_DIR?.trim();
  const legacyDataDir = expandPath(`~/.local/share/pi-issue-worker/${repositorySlug}`, home);
  const hashedDataDir = expandPath(
    `~/.local/share/pi-issue-worker/${repositorySlug}-${repositoryIdentityHash}`,
    home,
  );
  const dataDir = explicitDataDir
    ? expandPath(explicitDataDir, home)
    : directoryExists(legacyDataDir)
      ? legacyDataDir
      : hashedDataDir;
  const configuredDockerSocket = expandPath(
    env.PI_WORKER_DOCKER_SOCKET?.trim() || "/var/run/docker.sock",
    home,
  );
  const automaticDocker = (() => {
    try {
      if (!statSync(configuredDockerSocket).isSocket()) return false;
      accessSync(configuredDockerSocket, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  const allowDocker = env.PI_WORKER_ALLOW_DOCKER === undefined
    ? automaticDocker
    : booleanFlag("PI_WORKER_ALLOW_DOCKER", env.PI_WORKER_ALLOW_DOCKER);
  let dockerSocket = allowDocker ? configuredDockerSocket : null;
  const evidenceBranch = env.PI_WORKER_EVIDENCE_BRANCH?.trim() || "pi-evidence";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(evidenceBranch) ||
    evidenceBranch.includes("..") ||
    evidenceBranch.endsWith("/") ||
    evidenceBranch === baseBranch
  ) {
    throw new Error("PI_WORKER_EVIDENCE_BRANCH is not a safe Git branch name");
  }
  if (dockerSocket) {
    try {
      if (!statSync(dockerSocket).isSocket()) {
        throw new Error("path is not a Unix socket");
      }
      dockerSocket = realpathSync(dockerSocket);
    } catch (error) {
      throw new Error(
        `PI_WORKER_DOCKER_SOCKET must reference an accessible Unix socket: ${dockerSocket} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

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
    dataDir,
    pollSeconds: positiveInteger("PI_WORKER_POLL_SECONDS", env.PI_WORKER_POLL_SECONDS || "", 60),
    maxIssuesPerPoll: positiveInteger(
      "PI_WORKER_MAX_ISSUES_PER_POLL",
      env.PI_WORKER_MAX_ISSUES_PER_POLL || "",
      1,
    ),
    maxCiFixAttempts: positiveInteger(
      "PI_WORKER_MAX_CI_FIX_ATTEMPTS",
      env.PI_WORKER_MAX_CI_FIX_ATTEMPTS || "",
      3,
    ),
    agentTimeoutMinutes: boundedPositiveInteger(
      "PI_WORKER_AGENT_TIMEOUT_MINUTES",
      env.PI_WORKER_AGENT_TIMEOUT_MINUTES || "",
      60,
      1_440,
    ),
    thinkingLevel: thinking as ThinkingLevel,
    model,
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
    sandboxAllowedDomains: [...new Set(sandboxAllowedDomains)],
    allowDocker,
    dockerSocket,
    publishEvidence: booleanFlag(
      "PI_WORKER_PUBLISH_EVIDENCE",
      env.PI_WORKER_PUBLISH_EVIDENCE ?? "1",
    ),
    evidenceBranch,
    qaManifestPath: safeRepositoryPath(
      env.PI_WORKER_QA_MANIFEST?.trim() || ".pi-worker/qa.json",
      "PI_WORKER_QA_MANIFEST",
    ),
  };
}
