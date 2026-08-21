import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkerConfig } from "./config.js";
import { execFile } from "./exec.js";
import { slugify } from "./slug.js";

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

export class RepositoryManager {
  readonly controlPath: string;
  readonly worktreesRoot: string;

  constructor(
    private readonly config: WorkerConfig,
    private readonly run = execFile,
  ) {
    this.controlPath = join(config.dataDir, "repository");
    this.worktreesRoot = join(config.dataDir, "worktrees");
  }

  async ensureControlRepository(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    const exists = await access(join(this.controlPath, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await this.run(
        "git",
        [
          "clone",
          "--branch",
          this.config.baseBranch,
          "--single-branch",
          this.config.repositoryUrl,
          this.controlPath,
        ],
        { timeoutMs: 10 * 60_000 },
      );
    }
    await this.validateControlOrigin();
    await this.ensureLocalExcludes();
    await this.fetchBase();
  }

  private async validateControlOrigin(): Promise<void> {
    const origin = (
      await this.run("git", ["remote", "get-url", "origin"], { cwd: this.controlPath })
    ).stdout.trim();
    if (repositoryIdentity(origin) !== repositoryIdentity(this.config.repositoryUrl)) {
      throw new Error(
        `Control clone origin mismatch: expected ${this.config.repositoryUrl}, found ${origin}`,
      );
    }
  }

  private async ensureLocalExcludes(): Promise<void> {
    const common = (
      await this.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: this.controlPath,
      })
    ).stdout.trim();
    const excludeFile = join(common, "info", "exclude");
    await mkdir(join(common, "info"), { recursive: true });
    const current = await readFile(excludeFile, "utf8").catch(() => "");
    if (!current.split(/\r?\n/).includes("/.qa/")) {
      await appendFile(excludeFile, `${current.endsWith("\n") || !current ? "" : "\n"}/.qa/\n`);
    }
  }

  async fetchBase(): Promise<void> {
    await this.run(
      "git",
      [
        "fetch",
        "--prune",
        "origin",
        `refs/heads/${this.config.baseBranch}:refs/remotes/origin/${this.config.baseBranch}`,
      ],
      { cwd: this.controlPath, timeoutMs: 5 * 60_000 },
    );
  }

  branchForIssue(issueNumber: number, title: string): string {
    return `pi/issue-${issueNumber}-${slugify(title, 40)}`;
  }

  pathForIssue(issueNumber: number): string {
    return join(this.worktreesRoot, `issue-${issueNumber}`);
  }

  async ensureIssueWorktree(
    issueNumber: number,
    branchOrTitle: string,
    claimedPath?: string,
  ): Promise<{ branch: string; path: string }> {
    await this.fetchBase();
    await mkdir(this.worktreesRoot, { recursive: true });
    const branch = claimedPath ? branchOrTitle : this.branchForIssue(issueNumber, branchOrTitle);
    const path = claimedPath || this.pathForIssue(issueNumber);
    const expectedPath = resolve(path);
    const registered = await this.isRegistered(expectedPath);
    if (registered) {
      await this.validateWorktree(expectedPath, branch);
      return { branch, path: expectedPath };
    }
    if (expectedPath !== resolve(this.pathForIssue(issueNumber))) {
      throw new Error(`Refusing unregistered worktree path outside issue allocation: ${path}`);
    }
    const worktreePath = expectedPath;

    const pathExists = await access(worktreePath)
      .then(() => true)
      .catch(() => false);
    if (pathExists) {
      throw new Error(`Refusing unregistered pre-existing worktree path: ${worktreePath}`);
    }

    const localBranch = await this.run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: this.controlPath, allowFailure: true },
    );
    if (localBranch.exitCode === 0) {
      await this.run("git", ["worktree", "add", worktreePath, branch], { cwd: this.controlPath });
    } else {
      const remoteBranch = await this.run(
        "git",
        ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
        { cwd: this.controlPath, allowFailure: true, timeoutMs: 120_000 },
      );
      const startPoint = remoteBranch.exitCode === 0 ? `origin/${branch}` : `origin/${this.config.baseBranch}`;
      if (remoteBranch.exitCode === 0) {
        await this.run(
          "git",
          ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
          { cwd: this.controlPath, timeoutMs: 5 * 60_000 },
        );
      }
      await this.run(
        "git",
        ["worktree", "add", "-b", branch, worktreePath, startPoint],
        { cwd: this.controlPath, timeoutMs: 5 * 60_000 },
      );
    }
    await this.validateWorktree(worktreePath, branch);
    return { branch, path: worktreePath };
  }

  private async validateWorktree(path: string, branch: string): Promise<void> {
    const symbolicBranch = (
      await this.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path })
    ).stdout.trim();
    if (symbolicBranch !== branch) {
      throw new Error(`Worktree branch mismatch at ${path}: expected ${branch}, found ${symbolicBranch || "detached HEAD"}`);
    }
    const head = (await this.run("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
    const entry = await this.worktreeEntry(path);
    if (!entry || entry.head !== head || entry.branch !== `refs/heads/${branch}`) {
      throw new Error(`Registered worktree identity mismatch at ${path}`);
    }
  }

  private async worktreeEntry(path: string): Promise<{ head: string; branch: string } | null> {
    const result = await this.run("git", ["worktree", "list", "--porcelain"], {
      cwd: this.controlPath,
    });
    const lines = result.stdout.split(/\r?\n/);
    const expected = resolve(path);
    for (let index = 0; index < lines.length; index += 1) {
      if ((lines[index] || "") !== `worktree ${expected}`) continue;
      const headLine = lines[index + 1] || "";
      const head = headLine.startsWith("HEAD ") ? headLine.slice(5).trim() : "";
      const branchLine = lines
        .slice(index + 2)
        .find((line) => line === "" || line.startsWith("worktree ") || line.startsWith("branch "));
      return {
        head,
        branch: branchLine?.startsWith("branch ")
          ? branchLine.slice("branch ".length).trim()
          : "",
      };
    }
    return null;
  }

  private async isRegistered(path: string): Promise<boolean> {
    const result = await this.run("git", ["worktree", "list", "--porcelain"], {
      cwd: this.controlPath,
    });
    const expected = resolve(path);
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some((line) => resolve(line.slice("worktree ".length)) === expected);
  }

  async changedFiles(worktree: string): Promise<string[]> {
    const result = await this.run("git", ["status", "--porcelain", "-z"], { cwd: worktree });
    const entries = result.stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || entry.length < 4) continue;
      files.push(entry.slice(3));
      if (entry[0] === "R" || entry[1] === "R") {
        const original = entries[index + 1];
        if (original) files.push(original);
        index += 1;
      }
    }
    return files;
  }

  async commitAndPush(
    worktree: string,
    branch: string,
    commitMessage: string,
  ): Promise<{ commit: string; files: string[] }> {
    await this.validateWorktree(worktree, branch);
    const files = await this.changedFiles(worktree);
    if (files.length === 0) throw new Error("Pi completed without changing any files");
    const protectedFiles = files.filter((path) => isProtectedChange(path, this.config.protectedPaths));
    if (protectedFiles.length > 0) {
      throw new Error(`Protected paths were changed: ${protectedFiles.join(", ")}`);
    }

    await this.run("git", ["add", "--all"], { cwd: worktree });
    const staged = await this.run("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: worktree,
    });
    const stagedFiles = staged.stdout.split("\0").filter(Boolean);
    const protectedStaged = stagedFiles.filter((path) =>
      isProtectedChange(path, this.config.protectedPaths),
    );
    if (protectedStaged.length > 0) {
      await this.run("git", ["reset"], { cwd: worktree });
      throw new Error(`Protected paths were staged: ${protectedStaged.join(", ")}`);
    }

    await this.run("git", ["commit", "-m", commitMessage], {
      cwd: worktree,
      timeoutMs: 5 * 60_000,
    });
    const commit = (
      await this.run("git", ["rev-parse", "HEAD"], { cwd: worktree })
    ).stdout.trim();
    await this.validateWorktree(worktree, branch);
    await this.run("git", ["push", "--set-upstream", "origin", branch], {
      cwd: worktree,
      timeoutMs: 10 * 60_000,
    });
    return { commit, files: stagedFiles };
  }

  async hasCommitsAhead(worktree: string): Promise<boolean> {
    await this.fetchBase();
    const result = await this.run(
      "git",
      ["rev-list", "--count", `origin/${this.config.baseBranch}..HEAD`],
      { cwd: worktree },
    );
    return Number.parseInt(result.stdout.trim() || "0", 10) > 0;
  }

  async pushIfAhead(worktree: string, branch: string): Promise<void> {
    await this.validateWorktree(worktree, branch);
    await this.run("git", ["push", "origin", branch], {
      cwd: worktree,
      timeoutMs: 10 * 60_000,
    });
  }

  describePath(path: string): string {
    return relative(this.config.dataDir, path) || ".";
  }
}
