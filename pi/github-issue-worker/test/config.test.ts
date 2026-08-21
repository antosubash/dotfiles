import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const base = {
  HOME: "/tmp/home",
  PI_WORKER_REPOSITORY: "example/widgets",
  PI_WORKER_BASE_BRANCH: "develop",
};

test("loadConfig derives repository-specific generic defaults", () => {
  const config = loadConfig(base);
  assert.equal(config.repositoryUrl, "https://github.com/example/widgets.git");
  assert.equal(config.dataDir, "/tmp/home/.local/share/pi-issue-worker/example-widgets");
  assert.equal(config.readyLabel, "pi-ready");
  assert.equal(config.workingLabel, "pi-working");
  assert.equal(config.baseBranch, "develop");
  assert.deepEqual(config.protectedPaths, [".git", ".github/workflows", ".pi"]);
});

test("loadConfig supports one instance profile per repository", () => {
  const config = loadConfig({
    ...base,
    PI_WORKER_LABEL_PREFIX: "agent",
    PI_WORKER_PROTECTED_PATHS: ".git,ops/worker",
    PI_WORKER_TRUSTED_ASSOCIATIONS: "owner, member",
  });
  assert.equal(config.readyLabel, "agent-ready");
  assert.equal(config.pullRequestLabel, "agent-pr-open");
  assert.deepEqual(config.protectedPaths, [".git", "ops/worker"]);
  assert.deepEqual([...config.trustedAssociations], ["OWNER", "MEMBER"]);
});

test("loadConfig requires repository identity and an explicit base branch", () => {
  assert.throws(() => loadConfig({}), /PI_WORKER_REPOSITORY/);
  assert.throws(() => loadConfig({ PI_WORKER_REPOSITORY: "invalid" }), /owner\/repository/);
  assert.throws(
    () => loadConfig({ PI_WORKER_REPOSITORY: "example/widgets" }),
    /PI_WORKER_BASE_BRANCH/,
  );
});
