import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkerConfig } from "./config.js";
import type { JobKind } from "./types.js";
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

export class BranchDivergenceError extends Error {}

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

  pathForPullRequest(prNumber: number): string {
    return join(this.worktreesRoot, `pr-${prNumber}`);
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

  async ensurePullRequestWorktree(
    prNumber: number,
    branch: string,
    expectedHead: string,
    claimedPath?: string,
  ): Promise<{ branch: string; path: string }> {
    await this.fetchBase();
    await mkdir(this.worktreesRoot, { recursive: true });
    const path = claimedPath || this.pathForPullRequest(prNumber);
    const expectedPath = resolve(path);
    if (expectedPath !== resolve(this.pathForPullRequest(prNumber))) {
      throw new Error(`Refusing worktree path outside pull request allocation: ${path}`);
    }
    await this.run("git", ["check-ref-format", "--branch", branch], { cwd: this.controlPath });
    const previousRemote = await this.run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      { cwd: this.controlPath, allowFailure: true },
    );
    const previousRemoteHead = previousRemote.exitCode === 0 ? previousRemote.stdout.trim() : null;
    const registered = await this.isRegistered(expectedPath);
    let localHead: string | null = null;
    if (registered) {
      await this.validateWorktree(expectedPath, branch);
      localHead = await this.headRevision(expectedPath);
    }
    await this.run(
      "git",
      ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: this.controlPath, timeoutMs: 5 * 60_000 },
    );
    const remoteHead = (
      await this.run("git", ["rev-parse", `refs/remotes/origin/${branch}`], {
        cwd: this.controlPath,
      })
    ).stdout.trim();
    if (remoteHead !== expectedHead) {
      throw new Error(
        `Pull request #${prNumber} head changed during adoption (${expectedHead} != ${remoteHead})`,
      );
    }
    if (registered) {
      if (localHead !== remoteHead) {
        const changed = await this.changedFiles(expectedPath);
        const mergeInProgress = await this.hasMergeInProgress(expectedPath);
        if (localHead !== previousRemoteHead || changed.length > 0 || mergeInProgress) {
          throw new Error(
            `Refusing stale pull request worktree update (${localHead} != ${remoteHead}); local work may be present`,
          );
        }
        await this.run("git", ["reset", "--hard", remoteHead], { cwd: expectedPath });
      }
      await this.validateWorktree(expectedPath, branch);
      return { branch, path: expectedPath };
    }
    const pathExists = await access(expectedPath)
      .then(() => true)
      .catch(() => false);
    if (pathExists) {
      throw new Error(`Refusing unregistered pre-existing worktree path: ${expectedPath}`);
    }
    const localBranch = await this.run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: this.controlPath, allowFailure: true },
    );
    if (localBranch.exitCode === 0) {
      const branchHead = (
        await this.run("git", ["rev-parse", `refs/heads/${branch}`], { cwd: this.controlPath })
      ).stdout.trim();
      if (branchHead !== remoteHead) {
        if (branchHead !== previousRemoteHead) {
          throw new Error(
            `Refusing pull request #${prNumber}: local branch ${branch} contains untracked controller history`,
          );
        }
        await this.run("git", ["branch", "--force", branch, remoteHead], {
          cwd: this.controlPath,
        });
      }
      await this.run("git", ["worktree", "add", expectedPath, branch], {
        cwd: this.controlPath,
        timeoutMs: 5 * 60_000,
      });
    } else {
      await this.run(
        "git",
        ["worktree", "add", "-b", branch, expectedPath, `refs/remotes/origin/${branch}`],
        { cwd: this.controlPath, timeoutMs: 5 * 60_000 },
      );
    }
    await this.validateWorktree(expectedPath, branch);
    return { branch, path: expectedPath };
  }

  async removeManagedWorktree(
    kind: JobKind,
    number: number,
    worktree: string,
    branch: string,
    expectedHead: string,
  ): Promise<void> {
    const expectedPath = resolve(
      kind === "pull_request" ? this.pathForPullRequest(number) : this.pathForIssue(number),
    );
    if (resolve(worktree) !== expectedPath) {
      throw new Error(`Refusing cleanup outside managed ${kind} allocation: ${worktree}`);
    }
    if (!(await this.isRegistered(expectedPath))) {
      const exists = await access(expectedPath)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`Refusing unregistered cleanup path: ${expectedPath}`);
      return;
    }
    await this.validateWorktree(expectedPath, branch);
    if (await this.hasMergeInProgress(expectedPath)) {
      throw new Error(`Refusing cleanup with a merge in progress: ${expectedPath}`);
    }
    const changed = await this.changedFiles(expectedPath);
    if (changed.length > 0) {
      throw new Error(`Refusing cleanup with tracked or untracked changes: ${changed.join(", ")}`);
    }
    const head = await this.headRevision(expectedPath);
    if (head !== expectedHead) {
      throw new Error(
        `Refusing cleanup because worktree HEAD ${head} does not match merged PR head ${expectedHead}`,
      );
    }
    await this.run("git", ["worktree", "remove", expectedPath], {
      cwd: this.controlPath,
      timeoutMs: 5 * 60_000,
    });
    await this.run("git", ["worktree", "prune"], { cwd: this.controlPath });
    const remains = await access(expectedPath)
      .then(() => true)
      .catch(() => false);
    if (remains) throw new Error(`Worktree cleanup did not remove ${expectedPath}`);
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

  async headRevision(worktree: string): Promise<string> {
    return (await this.run("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
  }

  async filesChangedBetween(
    worktree: string,
    fromRevision: string,
    toRevision?: string,
  ): Promise<string[]> {
    const result = await this.run(
      "git",
      [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        fromRevision,
        ...(toRevision ? [toRevision] : []),
      ],
      { cwd: worktree },
    );
    return result.stdout.split("\0").filter(Boolean);
  }

  async filesAheadOfBase(worktree: string): Promise<string[]> {
    const result = await this.run(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", `origin/${this.config.baseBranch}...HEAD`],
      { cwd: worktree },
    );
    return result.stdout.split("\0").filter(Boolean);
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

  async beginBaseMerge(
    worktree: string,
    branch: string,
    expectedHead: string,
  ): Promise<{
    baseSha: string;
    conflicts: string[];
    alreadyCurrent: boolean;
    mergeInProgress: boolean;
  }> {
    await this.validateWorktree(worktree, branch);
    if ((await this.headRevision(worktree)) !== expectedHead) {
      throw new Error(`Feature worktree moved from expected pull request head ${expectedHead}`);
    }
    await this.assertRemoteBranchRevision(worktree, branch, expectedHead);
    await this.fetchBase();
    const baseRef = `origin/${this.config.baseBranch}`;
    const fetchedBaseSha = (await this.run("git", ["rev-parse", baseRef], { cwd: worktree })).stdout.trim();
    const mergeHead = await this.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
      cwd: worktree,
      allowFailure: true,
    });
    let mergeInProgress = mergeHead.exitCode === 0;
    const baseSha = mergeInProgress ? mergeHead.stdout.trim() : fetchedBaseSha;
    if (mergeInProgress) {
      const trustedAncestor = await this.run(
        "git",
        ["merge-base", "--is-ancestor", baseSha, baseRef],
        { cwd: worktree, allowFailure: true },
      );
      if (trustedAncestor.exitCode !== 0) {
        await this.abortBaseMerge(worktree);
        throw new Error(`Existing merge head ${baseSha} is not part of the trusted ${baseRef} history`);
      }
    } else {
      const changed = await this.changedFiles(worktree);
      if (changed.length > 0) {
        throw new Error(`Cannot update from ${baseRef} with existing worktree changes: ${changed.join(", ")}`);
      }
      const current = await this.run("git", ["merge-base", "--is-ancestor", baseRef, "HEAD"], {
        cwd: worktree,
        allowFailure: true,
      });
      if (current.exitCode === 0) {
        return { baseSha, conflicts: [], alreadyCurrent: true, mergeInProgress: false };
      }
      const merged = await this.run("git", ["merge", "--no-commit", "--no-ff", baseRef], {
        cwd: worktree,
        allowFailure: true,
        timeoutMs: 10 * 60_000,
      });
      if (merged.exitCode !== 0) {
        const conflicts = await this.unmergedFiles(worktree);
        if (conflicts.length === 0) {
          await this.abortBaseMerge(worktree);
          throw new Error(`Unable to merge ${baseRef}: ${merged.stderr || merged.stdout}`);
        }
      }
      mergeInProgress = true;
    }
    const conflicts = await this.unmergedFiles(worktree);
    const protectedConflicts = conflicts.filter((path) =>
      isProtectedChange(path, this.config.protectedPaths),
    );
    if (protectedConflicts.length > 0) {
      await this.abortBaseMerge(worktree);
      throw new Error(`Merge conflicts touch protected paths: ${protectedConflicts.join(", ")}`);
    }
    return { baseSha, conflicts, alreadyCurrent: false, mergeInProgress };
  }

  async hasMergeInProgress(worktree: string): Promise<boolean> {
    const mergeHead = await this.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
      cwd: worktree,
      allowFailure: true,
    });
    return mergeHead.exitCode === 0;
  }

  async unmergedFiles(worktree: string): Promise<string[]> {
    const result = await this.run("git", ["diff", "--name-only", "--diff-filter=U", "-z"], {
      cwd: worktree,
    });
    return result.stdout.split("\0").filter(Boolean);
  }

  async finishBaseMerge(
    worktree: string,
    branch: string,
    issueNumber: number,
    expectedHead: string,
  ): Promise<void> {
    await this.validateWorktree(worktree, branch);
    const mergeHead = await this.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
      cwd: worktree,
      allowFailure: true,
    });
    if (mergeHead.exitCode !== 0) throw new Error("No base merge is in progress");
    const trustedMergeBase = mergeHead.stdout.trim();
    const conflicts = await this.unmergedFiles(worktree);
    for (const path of conflicts) {
      const content = await readFile(join(worktree, path), "utf8").catch(() => "");
      if (/^(?:<<<<<<< |=======|>>>>>>> )/m.test(content)) {
        throw new Error(`Pi left conflict markers in ${path}`);
      }
    }
    await this.run("git", ["add", "--all"], { cwd: worktree });
    const unresolved = await this.unmergedFiles(worktree);
    if (unresolved.length > 0) {
      throw new Error(`Pi left unresolved merge conflicts: ${unresolved.join(", ")}`);
    }
    const staged = await this.run(
      "git",
      ["diff", "--cached", "--no-renames", "--name-only", "-z"],
      { cwd: worktree },
    );
    const stagedFiles = staged.stdout.split("\0").filter(Boolean);
    for (const path of stagedFiles) {
      const content = await readFile(join(worktree, path), "utf8").catch(() => "");
      if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======|>>>>>>> )/m.test(content)) {
        await this.run("git", ["reset"], { cwd: worktree });
        throw new Error(`Merge result still contains conflict markers in ${path}`);
      }
    }
    for (const path of stagedFiles.filter((candidate) =>
      isProtectedChange(candidate, this.config.protectedPaths),
    )) {
      const inherited = await this.run(
        "git",
        ["diff", "--cached", "--quiet", trustedMergeBase, "--", path],
        { cwd: worktree, allowFailure: true },
      );
      if (inherited.exitCode !== 0) {
        await this.run("git", ["reset"], { cwd: worktree });
        throw new Error(`Protected path differs from the trusted base during merge: ${path}`);
      }
    }
    await this.run("git", ["commit", "-m", `merge: update ${this.config.baseBranch} for #${issueNumber}`], {
      cwd: worktree,
      timeoutMs: 5 * 60_000,
    });
    await this.assertRemoteBranchRevision(worktree, branch, expectedHead);
    await this.pushIfAhead(worktree, branch);
  }

  async recoverBaseMergePush(
    worktree: string,
    branch: string,
    expectedHead: string,
    expectedBase: string,
  ): Promise<void> {
    await this.validateWorktree(worktree, branch);
    const localHead = await this.headRevision(worktree);
    const revision = (
      await this.run("git", ["rev-list", "--parents", "-n", "1", localHead], { cwd: worktree })
    ).stdout.trim().split(/\s+/);
    if (revision.length !== 3 || revision[1] !== expectedHead) {
      throw new BranchDivergenceError(
        `Local head ${localHead} is not the expected controller-created base merge`,
      );
    }
    const baseParent = revision[2]!;
    if (baseParent !== expectedBase) {
      throw new BranchDivergenceError(
        `Merge parent ${baseParent} does not match the expected trusted base ${expectedBase}`,
      );
    }
    const changed = await this.run(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", expectedHead, localHead],
      { cwd: worktree },
    );
    const changedFiles = changed.stdout.split("\0").filter(Boolean);
    for (const path of changedFiles) {
      const content = await readFile(join(worktree, path), "utf8").catch(() => "");
      if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======|>>>>>>> )/m.test(content)) {
        throw new BranchDivergenceError(`Recovered merge contains conflict markers in ${path}`);
      }
    }
    for (const path of changedFiles.filter((candidate) =>
      isProtectedChange(candidate, this.config.protectedPaths),
    )) {
      const inherited = await this.run(
        "git",
        ["diff", "--quiet", baseParent, localHead, "--", path],
        { cwd: worktree, allowFailure: true },
      );
      if (inherited.exitCode !== 0) {
        throw new BranchDivergenceError(
          `Recovered merge modified protected path beyond the trusted base: ${path}`,
        );
      }
    }
    const remoteHead = await this.remoteBranchRevision(worktree, branch);
    if (remoteHead === localHead) return;
    if (remoteHead !== expectedHead) {
      throw new BranchDivergenceError(
        `Remote branch moved from expected head ${expectedHead} to ${remoteHead || "missing"}`,
      );
    }
    await this.pushIfAhead(worktree, branch);
  }

  private async remoteBranchRevision(worktree: string, branch: string): Promise<string | null> {
    const remote = await this.run(
      "git",
      ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
      { cwd: worktree, timeoutMs: 120_000 },
    );
    return remote.stdout.trim().split(/\s+/)[0] || null;
  }

  private async assertRemoteBranchRevision(
    worktree: string,
    branch: string,
    expectedHead: string,
  ): Promise<void> {
    const remoteHead = await this.remoteBranchRevision(worktree, branch);
    if (remoteHead !== expectedHead) {
      throw new BranchDivergenceError(
        `Remote branch moved from expected head ${expectedHead} to ${remoteHead || "missing"}`,
      );
    }
  }

  async abortBaseMerge(worktree: string): Promise<void> {
    const mergeHead = await this.run("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
      cwd: worktree,
      allowFailure: true,
    });
    if (mergeHead.exitCode === 0) {
      await this.run("git", ["merge", "--abort"], { cwd: worktree, allowFailure: true });
    }
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

  async clearAgentChanges(worktree: string, branch: string): Promise<void> {
    await this.validateWorktree(worktree, branch);
    try {
      await this.run("git", ["reset", "--hard", "HEAD"], { cwd: worktree });
      await this.run("git", ["clean", "-fdx", "-e", ".qa"], { cwd: worktree });
    } catch (cleanupError) {
      try {
        await this.run("git", ["worktree", "remove", "--force", worktree], {
          cwd: this.controlPath,
        });
      } catch (removalError) {
        throw new Error(
          `Unable to clean or remove blocked agent worktree: ${String(cleanupError)}; ${String(removalError)}`,
        );
      }
    }
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

  async hasUnpushedCommits(worktree: string, branch: string): Promise<boolean> {
    const remoteBranch = await this.run(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      { cwd: worktree, allowFailure: true, timeoutMs: 120_000 },
    );
    if (remoteBranch.exitCode !== 0) return this.hasCommitsAhead(worktree);
    await this.run(
      "git",
      ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: worktree, timeoutMs: 5 * 60_000 },
    );
    const result = await this.run(
      "git",
      ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
      { cwd: worktree },
    );
    const [behindText = "0", aheadText = "0"] = result.stdout.trim().split(/\s+/);
    const behind = Number.parseInt(behindText, 10);
    const ahead = Number.parseInt(aheadText, 10);
    if (behind > 0) {
      throw new Error(
        `Remote branch origin/${branch} moved independently; automatic rebase or force-push is forbidden`,
      );
    }
    return ahead > 0;
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
