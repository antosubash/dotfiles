import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WorkerConfig } from "./config.js";
import type { JobKind } from "./types.js";
import { execFile } from "./exec.js";
import {
  branchForIssue,
  pathForIssue,
  pathForPullRequest,
  repositoryIdentity,
  type RepositoryContext,
} from "./repository/paths.js";
import {
  changedFiles,
  fetchBase,
  filesAheadOfBase,
  filesChangedBetween,
  hasMergeInProgress,
  headRevision,
  unmergedFiles,
} from "./repository/inspect.js";
import {
  ensureIssueWorktree,
  ensurePullRequestWorktree,
  removeManagedWorktree,
} from "./repository/worktrees.js";
import {
  abortBaseMerge,
  beginBaseMerge,
  finishBaseMerge,
  recoverBaseMergePush,
} from "./repository/merge.js";
import {
  clearAgentChanges,
  commitAndPush,
  hasCommitsAhead,
  hasUnpushedCommits,
  pushIfAhead,
} from "./repository/commits.js";

export { BranchDivergenceError, isProtectedChange, repositoryIdentity } from "./repository/paths.js";

export class RepositoryManager {
  readonly controlPath: string;
  readonly worktreesRoot: string;
  private readonly ctx: RepositoryContext;

  constructor(
    private readonly config: WorkerConfig,
    private readonly run = execFile,
  ) {
    this.controlPath = join(config.dataDir, "repository");
    this.worktreesRoot = join(config.dataDir, "worktrees");
    this.ctx = { config, run, controlPath: this.controlPath, worktreesRoot: this.worktreesRoot };
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

  fetchBase(): Promise<void> {
    return fetchBase(this.ctx);
  }

  branchForIssue(issueNumber: number, title: string): string {
    return branchForIssue(issueNumber, title);
  }

  pathForIssue(issueNumber: number): string {
    return pathForIssue(this.worktreesRoot, issueNumber);
  }

  pathForPullRequest(prNumber: number): string {
    return pathForPullRequest(this.worktreesRoot, prNumber);
  }

  ensureIssueWorktree(
    issueNumber: number,
    branchOrTitle: string,
    claimedPath?: string,
  ): Promise<{ branch: string; path: string }> {
    return ensureIssueWorktree(this.ctx, issueNumber, branchOrTitle, claimedPath);
  }

  ensurePullRequestWorktree(
    prNumber: number,
    branch: string,
    expectedHead: string,
    claimedPath?: string,
  ): Promise<{ branch: string; path: string }> {
    return ensurePullRequestWorktree(this.ctx, prNumber, branch, expectedHead, claimedPath);
  }

  removeManagedWorktree(
    kind: JobKind,
    number: number,
    worktree: string,
    branch: string,
    expectedHead: string,
    prNumber: number,
  ): Promise<void> {
    return removeManagedWorktree(this.ctx, kind, number, worktree, branch, expectedHead, prNumber);
  }

  headRevision(worktree: string): Promise<string> {
    return headRevision(this.ctx, worktree);
  }

  filesChangedBetween(
    worktree: string,
    fromRevision: string,
    toRevision?: string,
  ): Promise<string[]> {
    return filesChangedBetween(this.ctx, worktree, fromRevision, toRevision);
  }

  filesAheadOfBase(worktree: string): Promise<string[]> {
    return filesAheadOfBase(this.ctx, worktree);
  }

  changedFiles(worktree: string): Promise<string[]> {
    return changedFiles(this.ctx, worktree);
  }

  beginBaseMerge(
    worktree: string,
    branch: string,
    expectedHead: string,
  ): Promise<{
    baseSha: string;
    conflicts: string[];
    alreadyCurrent: boolean;
    mergeInProgress: boolean;
  }> {
    return beginBaseMerge(this.ctx, worktree, branch, expectedHead);
  }

  hasMergeInProgress(worktree: string): Promise<boolean> {
    return hasMergeInProgress(this.ctx, worktree);
  }

  unmergedFiles(worktree: string): Promise<string[]> {
    return unmergedFiles(this.ctx, worktree);
  }

  finishBaseMerge(
    worktree: string,
    branch: string,
    issueNumber: number,
    expectedHead: string,
  ): Promise<void> {
    return finishBaseMerge(this.ctx, worktree, branch, issueNumber, expectedHead);
  }

  recoverBaseMergePush(
    worktree: string,
    branch: string,
    expectedHead: string,
    expectedBase: string,
  ): Promise<void> {
    return recoverBaseMergePush(this.ctx, worktree, branch, expectedHead, expectedBase);
  }

  abortBaseMerge(worktree: string): Promise<void> {
    return abortBaseMerge(this.ctx, worktree);
  }

  commitAndPush(
    worktree: string,
    branch: string,
    commitMessage: string,
  ): Promise<{ commit: string; files: string[] }> {
    return commitAndPush(this.ctx, worktree, branch, commitMessage);
  }

  clearAgentChanges(worktree: string, branch: string): Promise<void> {
    return clearAgentChanges(this.ctx, worktree, branch);
  }

  hasCommitsAhead(worktree: string): Promise<boolean> {
    return hasCommitsAhead(this.ctx, worktree);
  }

  hasUnpushedCommits(worktree: string, branch: string): Promise<boolean> {
    return hasUnpushedCommits(this.ctx, worktree, branch);
  }

  pushIfAhead(worktree: string, branch: string): Promise<void> {
    return pushIfAhead(this.ctx, worktree, branch);
  }

  describePath(path: string): string {
    return relative(this.config.dataDir, path) || ".";
  }
}
