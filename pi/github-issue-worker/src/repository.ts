import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkerConfig } from "./config.js";
import { execFile } from "./exec.js";
import { slugify } from "./slug.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
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
    await this.ensureLocalExcludes();
    await this.fetchBase();
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

  async ensureIssueWorktree(issueNumber: number, title: string): Promise<{ branch: string; path: string }> {
    await this.fetchBase();
    await mkdir(this.worktreesRoot, { recursive: true });
    const branch = this.branchForIssue(issueNumber, title);
    const path = this.pathForIssue(issueNumber);
    const registered = await this.isRegistered(path);
    if (registered) return { branch, path };

    const pathExists = await access(path)
      .then(() => true)
      .catch(() => false);
    if (pathExists) {
      throw new Error(`Refusing unregistered pre-existing worktree path: ${path}`);
    }

    const localBranch = await this.run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: this.controlPath, allowFailure: true },
    );
    if (localBranch.exitCode === 0) {
      await this.run("git", ["worktree", "add", path, branch], { cwd: this.controlPath });
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
        ["worktree", "add", "-b", branch, path, startPoint],
        { cwd: this.controlPath, timeoutMs: 5 * 60_000 },
      );
    }
    return { branch, path };
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
    await this.run("git", ["push", "origin", branch], {
      cwd: worktree,
      timeoutMs: 10 * 60_000,
    });
  }

  describePath(path: string): string {
    return relative(this.config.dataDir, path) || ".";
  }
}
