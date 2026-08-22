import type { WorkerConfig } from "./config.js";
import { execFile } from "./exec.js";
import type {
  GitHubIssue,
  PullRequestCheckFailure,
  PullRequestChecks,
  PullRequestFeedback,
  PullRequestInfo,
  PullRequestMergeState,
} from "./types.js";

const WORKER_MARKER = "<!-- pi-issue-worker -->";

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

interface RawFeedback {
  id: number;
  body: string | null;
  html_url?: string;
  created_at?: string;
  submitted_at?: string;
  author_association?: string;
  user?: { login?: string };
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

export class GitHubClient {
  constructor(private readonly config: WorkerConfig) {}

  private async gh(args: readonly string[], input?: string): Promise<string> {
    const result = await execFile("gh", args, {
      ...(input === undefined ? {} : { input }),
      timeoutMs: 120_000,
    });
    return result.stdout.trim();
  }

  private async apiPages(endpoint: string): Promise<RawFeedback[]> {
    const output = await this.gh(["api", "--paginate", "--slurp", endpoint]);
    if (!output) return [];
    const pages = JSON.parse(output) as RawFeedback[][];
    return pages.flat();
  }

  async assertAuthenticated(): Promise<void> {
    await this.gh(["auth", "status", "--hostname", "github.com"]);
  }

  async ensureLabels(): Promise<void> {
    const labels = [
      [this.config.readyLabel, "1d76db", "Approved for the headless Pi worker"],
      [this.config.workingLabel, "fbca04", "The headless Pi worker is implementing this issue"],
      [this.config.pullRequestLabel, "0e8a16", "The headless Pi worker opened a draft pull request"],
      [this.config.blockedLabel, "d93f0b", "The headless Pi worker needs human help"],
      [this.config.visualLabel, "5319e7", "Capture local Playwright evidence under .qa"],
    ] as const;
    for (const [name, color, description] of labels) {
      await this.gh([
        "label",
        "create",
        name,
        "--repo",
        this.config.repository,
        "--color",
        color,
        "--description",
        description,
        "--force",
      ]);
    }
  }

  async listReadyIssues(): Promise<GitHubIssue[]> {
    const output = await this.gh([
      "issue",
      "list",
      "--repo",
      this.config.repository,
      "--state",
      "open",
      "--label",
      this.config.readyLabel,
      "--limit",
      String(this.config.maxIssuesPerPoll),
      "--json",
      "number,title,body,url,updatedAt,labels,author",
    ]);
    const issues = JSON.parse(output || "[]") as Array<GitHubIssue & { body: string | null }>;
    return issues.map((issue) => ({ ...issue, body: issue.body || "" }));
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const output = await this.gh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      this.config.repository,
      "--json",
      "number,title,body,url,updatedAt,labels,author",
    ]);
    const issue = JSON.parse(output) as GitHubIssue & { body: string | null };
    return { ...issue, body: issue.body || "" };
  }

  async claimIssue(issueNumber: number): Promise<void> {
    await this.gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.config.repository,
      "--remove-label",
      this.config.readyLabel,
      "--remove-label",
      this.config.blockedLabel,
      "--add-label",
      this.config.workingLabel,
    ]);
    await this.commentIssue(
      issueNumber,
      `🤖 Claimed. I am creating an isolated worktree from \`origin/${this.config.baseBranch}\` and starting implementation.`,
    );
  }

  async markBlocked(issueNumber: number, message: string): Promise<void> {
    await this.gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.config.repository,
      "--remove-label",
      this.config.workingLabel,
      "--add-label",
      this.config.blockedLabel,
    ]);
    await this.commentIssue(issueNumber, `⛔ Blocked.\n\n${message}`);
  }

  async markPullRequestOpen(issueNumber: number): Promise<void> {
    await this.gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.config.repository,
      "--remove-label",
      this.config.workingLabel,
      "--remove-label",
      this.config.blockedLabel,
      "--add-label",
      this.config.pullRequestLabel,
    ]);
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    await this.gh(
      [
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        this.config.repository,
        "--body-file",
        "-",
      ],
      `${WORKER_MARKER}\n${body}\n`,
    );
  }

  async commentPullRequest(prNumber: number, body: string): Promise<void> {
    await this.gh(
      [
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        this.config.repository,
        "--body-file",
        "-",
      ],
      `${WORKER_MARKER}\n${body}\n`,
    );
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    const output = await this.gh([
      "pr",
      "list",
      "--repo",
      this.config.repository,
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

  async createDraftPullRequest(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullRequestInfo> {
    const url = await this.gh(
      [
        "pr",
        "create",
        "--repo",
        this.config.repository,
        "--draft",
        "--base",
        this.config.baseBranch,
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

  async isPullRequestOpen(prNumber: number): Promise<boolean> {
    const state = await this.gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.config.repository,
      "--json",
      "state",
      "--jq",
      ".state",
    ]);
    return state === "OPEN";
  }

  async getPullRequestMergeState(prNumber: number): Promise<PullRequestMergeState> {
    const output = await this.gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.config.repository,
      "--json",
      "baseRefName,baseRefOid,headRefOid,mergeable,mergeStateStatus",
    ]);
    const state = JSON.parse(output) as {
      baseRefName: string;
      baseRefOid: string;
      headRefOid: string;
      mergeable: PullRequestMergeState["mergeable"];
      mergeStateStatus: string;
    };
    return {
      headSha: state.headRefOid,
      baseSha: state.baseRefOid,
      baseBranch: state.baseRefName,
      mergeable: state.mergeable,
      mergeStateStatus: state.mergeStateStatus,
    };
  }

  async getPullRequestChecks(
    prNumber: number,
    includeFailureLogs = false,
  ): Promise<PullRequestChecks> {
    const output = await this.gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.config.repository,
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
          ["run", "view", "--repo", this.config.repository, "--job", jobId, "--log"],
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

  async listFeedback(prNumber: number): Promise<PullRequestFeedback[]> {
    const base = `/repos/${this.config.repository}`;
    const sources = await Promise.all([
      this.apiPages(`${base}/issues/${prNumber}/comments`).then((items) =>
        items.map((item) => this.mapFeedback(item, "conversation")),
      ),
      this.apiPages(`${base}/pulls/${prNumber}/reviews`).then((items) =>
        items.map((item) => this.mapFeedback(item, "review")),
      ),
      this.apiPages(`${base}/pulls/${prNumber}/comments`).then((items) =>
        items.map((item) => this.mapFeedback(item, "review_comment")),
      ),
    ]);
    return sources
      .flat()
      .filter((item): item is PullRequestFeedback => item !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private mapFeedback(
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
