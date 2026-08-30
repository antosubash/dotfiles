import type { WorkerConfig } from "./config.js";
import type { EvidenceAttachment } from "./evidence.js";
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

export class GitHubClient {
  constructor(
    private readonly config: WorkerConfig,
    private readonly ghRunner?: (args: readonly string[], input?: string) => Promise<string>,
  ) {}

  private async gh(args: readonly string[], input?: string): Promise<string> {
    if (this.ghRunner) return await this.ghRunner(args, input);
    const result = await execFile("gh", args, {
      ...(input === undefined ? {} : { input }),
      timeoutMs: 120_000,
    });
    return result.stdout.trim();
  }

  private async ensureEvidenceBranch(): Promise<{
    headSha: string;
    treeSha: string;
    paths: ReadonlyMap<string, string>;
  }> {
    const branchPath = this.config.evidenceBranch.split("/").map(encodeURIComponent).join("/");
    try {
      const ref = JSON.parse(
        await this.gh(["api", `/repos/${this.config.repository}/git/ref/heads/${branchPath}`]),
      ) as { object: { sha: string } };
      const head = JSON.parse(
        await this.gh(["api", `/repos/${this.config.repository}/git/commits/${ref.object.sha}`]),
      ) as { tree: { sha: string } };
      const tree = JSON.parse(
        await this.gh([
          "api",
          `/repos/${this.config.repository}/git/trees/${head.tree.sha}?recursive=1`,
        ]),
      ) as { tree: Array<{ path: string; type?: string; sha?: string }>; truncated?: boolean };
      if (tree.truncated) {
        throw new Error(`Refusing evidence branch ${this.config.evidenceBranch}: tree listing is truncated`);
      }
      const unsafe = tree.tree.find(
        (entry) => entry.path !== "qa" && !entry.path.startsWith("qa/"),
      );
      if (unsafe) {
        throw new Error(
          `Refusing evidence branch ${this.config.evidenceBranch}: unexpected path ${unsafe.path}`,
        );
      }
      const pages = JSON.parse(
        await this.gh([
          "api",
          "--paginate",
          "--slurp",
          `/repos/${this.config.repository}/commits?sha=${encodeURIComponent(this.config.evidenceBranch)}&per_page=100`,
        ]),
      ) as Array<Array<{
        sha: string;
        parents: Array<{ sha: string }>;
        commit: { message: string; tree: { sha: string } };
      }>>;
      const history = pages.flat();
      if (history.length === 0 || history.length > 10_000 || history[0]!.sha !== ref.object.sha) {
        throw new Error(`Refusing evidence branch ${this.config.evidenceBranch}: invalid history`);
      }
      for (let index = 0; index < history.length - 1; index += 1) {
        const current = history[index]!;
        const parent = history[index + 1]!;
        if (
          current.parents.length !== 1 ||
          current.parents[0]!.sha !== parent.sha ||
          !current.commit.message.startsWith("qa: publish evidence for PR #")
        ) {
          throw new Error(`Refusing evidence branch ${this.config.evidenceBranch}: untrusted ancestry`);
        }
      }
      const root = history.at(-1)!;
      if (
        root.parents.length !== 0 ||
        root.commit.tree.sha !== "4b825dc642cb6eb9a060e54bf8d69288fbee4904" ||
        root.commit.message !== "Initialize Pi QA evidence branch"
      ) {
        throw new Error(`Refusing evidence branch ${this.config.evidenceBranch}: root is not worker-owned`);
      }
      const [owner, name] = this.config.repository.split("/") as [string, string];
      for (let offset = 0; offset < history.length; offset += 50) {
        const commits = history.slice(offset, offset + 50);
        const selections = commits
          .map(
            (commit, index) =>
              `t${index}: object(oid: \"${commit.commit.tree.sha}\") { ... on Tree { entries { name type } } }`,
          )
          .join("\n");
        const response = JSON.parse(
          await this.gh([
            "api",
            "graphql",
            "-f",
            `query=query { repository(owner: \"${owner}\", name: \"${name}\") { ${selections} } }`,
          ]),
        ) as {
          data?: { repository?: Record<string, { entries?: Array<{ name: string; type: string }> } | null> };
        };
        for (let index = 0; index < commits.length; index += 1) {
          const entries = response.data?.repository?.[`t${index}`]?.entries;
          if (!entries || entries.some((entry) => entry.name !== "qa")) {
            throw new Error(
              `Refusing evidence branch ${this.config.evidenceBranch}: historical tree contains an unexpected path`,
            );
          }
        }
      }
      return {
        headSha: ref.object.sha,
        treeSha: head.tree.sha,
        paths: new Map(
          tree.tree
            .filter((entry) => entry.type === "blob" && entry.sha)
            .map((entry) => [entry.path, entry.sha!] as const),
        ),
      };
    } catch (error) {
      if (!/HTTP 404|Not Found/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
    const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const commit = JSON.parse(
      await this.gh(
        ["api", "--method", "POST", `/repos/${this.config.repository}/git/commits`, "--input", "-"],
        JSON.stringify({ message: "Initialize Pi QA evidence branch", tree: emptyTreeSha, parents: [] }),
      ),
    ) as { sha: string };
    try {
      await this.gh(
        ["api", "--method", "POST", `/repos/${this.config.repository}/git/refs`, "--input", "-"],
        JSON.stringify({ ref: `refs/heads/${this.config.evidenceBranch}`, sha: commit.sha }),
      );
      return { headSha: commit.sha, treeSha: emptyTreeSha, paths: new Map() };
    } catch (error) {
      if (!/HTTP 422|Reference already exists/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      return await this.ensureEvidenceBranch();
    }
  }

  async publishEvidence(
    prNumber: number,
    headSha: string,
    runId: string,
    attachments: readonly EvidenceAttachment[],
  ): Promise<string> {
    if (!this.config.publishEvidence || attachments.length === 0) return "";
    const branch = await this.ensureEvidenceBranch();
    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    const published: Array<{ name: string; mediaType: EvidenceAttachment["mediaType"]; htmlUrl: string }> = [];
    for (const attachment of attachments) {
      const relativeParts = [
        "qa",
        `pr-${prNumber}`,
        headSha.slice(0, 12),
        runId,
        attachment.name,
      ];
      const relativePath = relativeParts.join("/");
      const blob = JSON.parse(
        await this.gh(
          ["api", "--method", "POST", `/repos/${this.config.repository}/git/blobs`, "--input", "-"],
          JSON.stringify({ content: attachment.content.toString("base64"), encoding: "base64" }),
        ),
      ) as { sha: string };
      treeEntries.push({ path: relativePath, mode: "100644", type: "blob", sha: blob.sha });
      const encodedPath = relativeParts.map(encodeURIComponent).join("/");
      const htmlUrl = `https://github.com/${this.config.repository}/blob/${encodeURIComponent(this.config.evidenceBranch)}/${encodedPath}`;
      published.push({ name: attachment.name, mediaType: attachment.mediaType, htmlUrl });
    }
    const markdown = () => {
      const lines = published.map((item) =>
        item.mediaType.startsWith("image/")
          ? `[![${item.name}](${item.htmlUrl}?raw=1)](${item.htmlUrl})`
          : `- [Download ${item.name}](${item.htmlUrl}?raw=1)`,
      );
      return `\n\n### Attached QA evidence\n${lines.join("\n\n")}`;
    };
    if (treeEntries.every((entry) => branch.paths.get(entry.path) === entry.sha)) {
      return markdown();
    }
    const tree = JSON.parse(
      await this.gh(
        ["api", "--method", "POST", `/repos/${this.config.repository}/git/trees`, "--input", "-"],
        JSON.stringify({ base_tree: branch.treeSha, tree: treeEntries }),
      ),
    ) as { sha: string };
    const commit = JSON.parse(
      await this.gh(
        ["api", "--method", "POST", `/repos/${this.config.repository}/git/commits`, "--input", "-"],
        JSON.stringify({
          message: `qa: publish evidence for PR #${prNumber}`,
          tree: tree.sha,
          parents: [branch.headSha],
        }),
      ),
    ) as { sha: string };
    const branchPath = this.config.evidenceBranch.split("/").map(encodeURIComponent).join("/");
    await this.gh(
      [
        "api",
        "--method",
        "PATCH",
        `/repos/${this.config.repository}/git/refs/heads/${branchPath}`,
        "--input",
        "-",
      ],
      JSON.stringify({ sha: commit.sha, force: false }),
    );
    return markdown();
  }

  private async apiPages<T = RawFeedback>(endpoint: string): Promise<T[]> {
    const output = await this.gh(["api", "--paginate", "--slurp", endpoint]);
    if (!output) return [];
    const pages = JSON.parse(output) as T[][];
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

  async findOpenPullRequestsForIssue(
    issueNumber: number,
    excludedBranch: string,
  ): Promise<PullRequestInfo[]> {
    const pulls = await this.apiPages<{
      number: number;
      html_url: string;
      head: { ref: string };
      title: string;
      body: string | null;
    }>(`/repos/${this.config.repository}/pulls?state=open&per_page=100`);
    const reference = new RegExp(`(^|[^0-9])#${issueNumber}(?![0-9])`);
    return pulls
      .filter(
        (pull) =>
          pull.head.ref !== excludedBranch &&
          reference.test(`${pull.title}\n${pull.body || ""}`),
      )
      .map(({ number, html_url: url }) => ({ number, url }));
  }

  async labelPullRequestFromIssue(
    prNumber: number,
    issue: GitHubIssue,
  ): Promise<void> {
    const transient = new Set([
      this.config.readyLabel.toLowerCase(),
      this.config.workingLabel.toLowerCase(),
      this.config.blockedLabel.toLowerCase(),
    ]);
    const labels = new Map<string, string>([
      [this.config.pullRequestLabel.toLowerCase(), this.config.pullRequestLabel],
    ]);
    for (const { name } of issue.labels) {
      const normalized = name.trim().toLowerCase();
      if (!normalized || transient.has(normalized) || labels.has(normalized)) continue;
      labels.set(normalized, name);
    }
    await this.gh(
      [
        "api",
        "--method",
        "POST",
        `/repos/${this.config.repository}/issues/${prNumber}/labels`,
        "--input",
        "-",
      ],
      JSON.stringify({ labels: [...labels.values()] }),
    );
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

  async rerunFailedWorkflowRuns(
    failures: readonly PullRequestCheckFailure[],
  ): Promise<number> {
    const runIds = new Set(
      failures
        .map((failure) => failure.detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1])
        .filter((runId): runId is string => Boolean(runId)),
    );
    for (const runId of runIds) {
      await this.gh(["run", "rerun", runId, "--repo", this.config.repository, "--failed"]);
    }
    return runIds.size;
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

  async listIssueCommands(issueNumber: number): Promise<PullRequestFeedback[]> {
    const items = await this.apiPages(
      `/repos/${this.config.repository}/issues/${issueNumber}/comments`,
    );
    return items
      .map((item) => this.mapFeedback(item, "conversation"))
      .filter((item): item is PullRequestFeedback => item !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
