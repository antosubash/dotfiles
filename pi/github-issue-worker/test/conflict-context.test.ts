import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GitHubClient } from "../src/github.js";
import { BranchDivergenceError } from "../src/repository.js";
import {
  assertPullRequestMergeContext,
  mergeConflictEventKey,
} from "../src/worker/conflict-context.js";
import { RetryableControllerError, type WorkerContext } from "../src/worker/shared.js";

const config = loadConfig({
  PI_WORKER_REPOSITORY: "example/widgets",
  PI_WORKER_BASE_BRANCH: "release/candidate",
  PI_WORKER_ALLOW_DOCKER: "0",
});
const head = "a".repeat(40);
const frozenBase = "b".repeat(40);
const currentBase = "c".repeat(40);
const movedBase = "d".repeat(40);

function pull(baseBranch = config.baseBranch, headSha = head): string {
  return JSON.stringify({
    baseRefName: baseBranch,
    baseRefOid: frozenBase,
    headRefOid: headSha,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
  });
}

function context(github: GitHubClient): WorkerContext {
  return { config, github } as WorkerContext;
}

test("a frozen PR base snapshot does not reject an unchanged live base branch", async () => {
  const client = new GitHubClient(config, async (args) => {
    if (args[0] === "pr") return pull();
    assert.deepEqual(args, [
      "api",
      "/repos/example/widgets/git/ref/heads/release/candidate",
    ]);
    return JSON.stringify({ object: { sha: currentBase, type: "commit" } });
  });

  const state = await client.getPullRequestMergeState(77);
  assert.equal(state.baseSha, currentBase);
  assert.notEqual(state.baseSha, frozenBase);
  assert.equal(
    mergeConflictEventKey(77, state),
    `merge-conflict:77:release/candidate:${head}:${currentBase}`,
  );
  await assertPullRequestMergeContext(context(client), 77, head, currentBase);
});

test("a live base branch move rejects a resolution computed against its prior target", async () => {
  let refReads = 0;
  const client = new GitHubClient(config, async (args) => {
    if (args[0] === "pr") return pull();
    refReads += 1;
    return JSON.stringify({
      object: { sha: refReads === 1 ? currentBase : movedBase, type: "commit" },
    });
  });

  const state = await client.getPullRequestMergeState(77);
  await assert.rejects(
    assertPullRequestMergeContext(context(client), 77, state.headSha, state.baseSha),
    BranchDivergenceError,
  );
});

test("base-ref transport and missing-ref failures keep conflict resolution retryable", async () => {
  for (const failure of ["gh api failed (1): 401 Unauthorized", "HTTP 404: Not Found"]) {
    const client = new GitHubClient(config, async (args) => {
      if (args[0] === "pr") return pull();
      throw new Error(failure);
    });
    await assert.rejects(
      assertPullRequestMergeContext(context(client), 77, head, currentBase),
      (error: unknown) =>
        error instanceof RetryableControllerError &&
        error.message.includes("could not confirm the merge context") &&
        error.message.includes(failure),
    );
  }
});

test("head changes and PR retargets remain divergence errors", async () => {
  for (const [baseBranch, headSha] of [[config.baseBranch, movedBase], ["main", head]] as const) {
    const client = new GitHubClient(config, async (args) => {
      if (args[0] === "pr") return pull(baseBranch, headSha);
      return JSON.stringify({ object: { sha: currentBase, type: "commit" } });
    });
    await assert.rejects(
      assertPullRequestMergeContext(context(client), 77, head, currentBase),
      BranchDivergenceError,
    );
  }
});
