import { apiPages, type GhRunner } from "./gh.js";

export interface ContentEdit { editor: string | null; editedAt: string }
export interface Approval { labeledBy: string | null; labeledAt: string | null; renames: ContentEdit[] }
export interface TrustService {
  canWrite(login: string): Promise<boolean>;
  approval(number: number, label: string): Promise<Approval>;
  bodyEdits(number: number): Promise<ContentEdit[]>;
  viewerLogin(): Promise<string | null>;
}

/** More edits than one GraphQL page: refuse rather than verify a partial history. */
export class TooManyEditsError extends Error {}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const PERMISSION_TTL_MS = 10 * 60_000;
const EDITS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { userContentEdits(first: 100) { nodes { editor { login } editedAt } pageInfo { hasNextPage } } }
      ... on PullRequest { userContentEdits(first: 100) { nodes { editor { login } editedAt } pageInfo { hasNextPage } } }
    }
  }
}`;

interface RawEvent {
  event: string;
  created_at: string;
  actor?: { login?: string } | null;
  label?: { name?: string } | null;
}

/** Write access from the collaborator-permission API; never author_association. */
export class GitHubTrust implements TrustService {
  private readonly permissions = new Map<string, { writable: boolean; at: number }>();
  private viewer: Promise<string | null> | null = null;

  constructor(
    private readonly gh: GhRunner,
    private readonly repository: string,
    private readonly now: () => number = Date.now,
  ) {}

  async canWrite(login: string): Promise<boolean> {
    const key = login.toLowerCase();
    const cached = this.permissions.get(key);
    if (cached && this.now() - cached.at < PERMISSION_TTL_MS) return cached.writable;
    let permission = "none";
    try {
      permission = await this.gh([
        "api",
        `/repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ]);
    } catch (error) {
      if (!/\(HTTP 404\)|\bHTTP 404:/.test(String(error))) throw error;
    }
    const writable = WRITE_PERMISSIONS.has(permission.trim().toLowerCase());
    this.permissions.set(key, { writable, at: this.now() });
    return writable;
  }

  async approval(number: number, label: string): Promise<Approval> {
    const events = await apiPages<RawEvent>(this.gh, `/repos/${this.repository}/issues/${number}/events?per_page=100`);
    let labeled: RawEvent | null = null;
    const renames: ContentEdit[] = [];
    for (const event of events) {
      // The newest matching event wins regardless of array order; a later index breaks timestamp ties.
      if (event.event === "labeled" && event.label?.name?.toLowerCase() === label.toLowerCase() &&
          (!labeled || Date.parse(event.created_at) >= Date.parse(labeled.created_at))) labeled = event;
      if (event.event === "renamed") renames.push({ editor: event.actor?.login ?? null, editedAt: event.created_at });
    }
    return { labeledBy: labeled?.actor?.login ?? null, labeledAt: labeled?.created_at ?? null, renames };
  }

  async bodyEdits(number: number): Promise<ContentEdit[]> {
    const [owner, name] = this.repository.split("/");
    const output = await this.gh([
      "api", "graphql",
      "-f", `query=${EDITS_QUERY}`,
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-F", `number=${number}`,
      "--jq", ".data.repository.issueOrPullRequest.userContentEdits",
    ]);
    const page = JSON.parse(output) as {
      nodes: Array<{ editor: { login: string } | null; editedAt: string }>;
      pageInfo: { hasNextPage: boolean };
    };
    if (page.pageInfo.hasNextPage) throw new TooManyEditsError(`#${number} has more than 100 edits`);
    return page.nodes.map((node) => ({ editor: node.editor?.login ?? null, editedAt: node.editedAt }));
  }

  viewerLogin(): Promise<string | null> {
    this.viewer ??= this.gh(["api", "user", "--jq", ".login"]).then(
      (login) => login.trim() || null,
      () => {
        this.viewer = null;
        return null;
      },
    );
    return this.viewer;
  }
}
