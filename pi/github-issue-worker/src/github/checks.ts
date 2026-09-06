import type { WorkerConfig } from "../config.js";
import { execFile } from "../exec.js";
import type { PullRequestCheckFailure, PullRequestChecks } from "../types.js";
import type { GhRunner } from "./gh.js";

interface RawCheckRollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

interface RawPullRequestChecks {
  headRefOid: string;
  statusCheckRollup: RawCheckRollupItem[] | null;
}

const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_CHECK_STATES = new Set([
  "EXPECTED",
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
]);

export function classifyPullRequestChecks(raw: RawPullRequestChecks): PullRequestChecks {
  const checks = raw.statusCheckRollup || [];
  if (checks.length === 0) return { headSha: raw.headRefOid, state: "none", failures: [] };
  const failures: PullRequestCheckFailure[] = [];
  let pending = false;
  for (const check of checks) {
    const state = (check.conclusion || check.state || check.status || "").toUpperCase();
    if (PENDING_CHECK_STATES.has(state) || (!state && check.status !== "COMPLETED")) {
      pending = true;
      continue;
    }
    if (PASSING_CHECK_STATES.has(state)) continue;
    failures.push({
      name: check.name || check.context || "unnamed check",
      conclusion: state || "UNKNOWN",
      detailsUrl: check.detailsUrl || check.targetUrl || null,
      excerpt: null,
    });
  }
  if (pending) return { headSha: raw.headRefOid, state: "pending", failures: [] };
  return {
    headSha: raw.headRefOid,
    state: failures.length > 0 ? "failed" : "passed",
    failures,
  };
}

export type CiFailureDisposition = "infrastructure" | "timeout" | "code";

export function ciFailureDisposition(
  failures: readonly PullRequestCheckFailure[],
): CiFailureDisposition {
  if (
    failures.length > 0 &&
    failures.every((failure) =>
      /^(?:CANCELLED|STALE|STARTUP_FAILURE|ACTION_REQUIRED|SKIPPED)$/i.test(
        failure.conclusion,
      ) ||
      /no self-hosted runner|not acquired by runner|startup_failure|HTTP 5\d\d|runner.*offline/i.test(
        failure.excerpt || "",
      ),
    )
  ) {
    return "infrastructure";
  }
  if (
    failures.length > 0 &&
    failures.every((failure) =>
      failure.conclusion === "TIMED_OUT" ||
      /test timed out|timed out in \d+ms|timeout exceeded/i.test(failure.excerpt || ""),
    )
  ) {
    return "timeout";
  }
  return "code";
}

export function extractFailureExcerpt(raw: string, maximum = 12_000): string {
  const sanitized = raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /^.*(?:authorization|client[_-]?secret|refresh[_-]?token|["']?(?:token|password|passwd|pass|secret|api[_-]?key)["']?|[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|PASS|SECRET|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*)\s*[:=].*$/gim,
      "[REDACTED_CREDENTIAL_LINE]",
    )
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED_CREDENTIALS]@")
    .replace(/(\b[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|PASS|SECRET|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*\s*=\s*)\S+/g, "$1[REDACTED]")
    .replace(/\b(?:xox[baprs]-|sk-(?:live-|test-)?|AIza|ya29\.)[A-Za-z0-9._-]{16,}\b/g, "[REDACTED_PROVIDER_SECRET]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/((?:authorization)["']?\s*[:=]\s*["']?)(?:basic|bearer|token)\s+[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:token|password|passwd|pass|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]")
    .replace(/([?&](?:access_token|api_key|key|password|secret|token)=)[^&\s]+/gi, "$1[REDACTED]")
    // Fail closed on opaque high-entropy values, even when their provider/variable name is unknown.
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, "[REDACTED_LONG_VALUE]");
  const lines = sanitized.split(/\r?\n/);
  const selected = new Set<number>();
  const interesting = /(?:^|[\s:#])(?:error|failed|failure|traceback|exception|assert|mismatch|hint:|fatal)\b|[✗×]/i;
  for (let index = 0; index < lines.length; index += 1) {
    if (!interesting.test(lines[index] || "")) continue;
    for (let offset = -2; offset <= 3; offset += 1) {
      if (index + offset >= 0 && index + offset < lines.length) selected.add(index + offset);
    }
  }
  const excerpt = (selected.size > 0
    ? [...selected].sort((left, right) => left - right).map((index) => lines[index])
    : lines.slice(-80)
  ).join("\n");
  return excerpt.length > maximum ? `${excerpt.slice(-maximum)}\n…truncated` : excerpt;
}

export async function rerunFailedWorkflowRuns(
  gh: GhRunner,
  config: WorkerConfig,
  failures: readonly PullRequestCheckFailure[],
): Promise<number> {
  const runIds = new Set(
    failures
      .map((failure) => failure.detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1])
      .filter((runId): runId is string => Boolean(runId)),
  );
  for (const runId of runIds) {
    await gh(["run", "rerun", runId, "--repo", config.repository, "--failed"]);
  }
  return runIds.size;
}

export async function getPullRequestChecks(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
  includeFailureLogs = false,
): Promise<PullRequestChecks> {
  const output = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    config.repository,
    "--json",
    "headRefOid,statusCheckRollup",
  ]);
  const checks = classifyPullRequestChecks(JSON.parse(output) as RawPullRequestChecks);
  if (checks.state !== "failed" || !includeFailureLogs) return checks;

  let remaining = 30_000;
  const failures: PullRequestCheckFailure[] = [];
  for (const failure of checks.failures.slice(0, 10)) {
    let excerpt: string | null = null;
    const jobId = failure.detailsUrl?.match(/\/job\/(\d+)/)?.[1];
    if (jobId && remaining > 0) {
      const result = await execFile(
        "gh",
        ["run", "view", "--repo", config.repository, "--job", jobId, "--log"],
        { allowFailure: true, timeoutMs: 120_000, maxOutputChars: 400_000 },
      );
      const candidate = extractFailureExcerpt(result.stdout || result.stderr, Math.min(12_000, remaining));
      excerpt = candidate || null;
      remaining -= candidate.length;
    }
    failures.push({ ...failure, excerpt });
  }
  return { ...checks, failures };
}
