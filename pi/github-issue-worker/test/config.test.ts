import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const base = {
  HOME: "/tmp/home",
  PI_WORKER_REPOSITORY: "example/widgets",
  PI_WORKER_BASE_BRANCH: "develop",
};

test("loadConfig uses a hashed default when no legacy directory exists", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-worker-config-"));
  try {
    const config = loadConfig({ ...base, HOME: home });
    assert.equal(config.repositoryUrl, "https://github.com/example/widgets.git");
    assert.match(config.dataDir, /\/example-widgets-[0-9a-f]{12}$/);
    assert.ok(config.sandboxAllowedDomains.includes("registry.npmjs.org"));
    assert.equal(config.readyLabel, "pi-ready");
    assert.equal(config.workingLabel, "pi-working");
    assert.equal(config.baseBranch, "develop");
    assert.equal(config.maxCiFixAttempts, 3);
    assert.equal(config.model, "openai-codex/gpt-5.6-terra");
    assert.deepEqual(config.protectedPaths, [".git", ".github/workflows", ".pi"]);
    assert.equal(config.allowDocker, config.dockerSocket !== null);
    assert.equal(config.publishEvidence, true);
    assert.equal(config.evidenceBranch, "pi-evidence");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig reuses an existing slug-only legacy directory", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-worker-config-"));
  const legacyDataDir = join(home, ".local/share/pi-issue-worker/example-widgets");
  try {
    mkdirSync(legacyDataDir, { recursive: true });
    assert.equal(loadConfig({ ...base, HOME: home }).dataDir, legacyDataDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig leaves an explicit data directory selected", () => {
  const config = loadConfig({ ...base, PI_WORKER_DATA_DIR: "/custom/worker-data" });
  assert.equal(config.dataDir, "/custom/worker-data");
});

test("default state directories distinguish repository identities that slug alike", () => {
  const first = loadConfig({ ...base, PI_WORKER_REPOSITORY: "acme/foo-bar" });
  const second = loadConfig({ ...base, PI_WORKER_REPOSITORY: "acme/foo_bar" });
  assert.notEqual(first.dataDir, second.dataDir);
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

test("loadConfig validates and overrides the Pi model", () => {
  assert.equal(
    loadConfig({ ...base, PI_WORKER_MODEL: "openai-codex/gpt-5.6-sol" }).model,
    "openai-codex/gpt-5.6-sol",
  );
  assert.throws(() => loadConfig({ ...base, PI_WORKER_MODEL: "gpt-5.6-luna" }), /provider\/model/);
});

test("loadConfig validates the CI repair attempt bound", () => {
  assert.equal(loadConfig({ ...base, PI_WORKER_MAX_CI_FIX_ATTEMPTS: "2" }).maxCiFixAttempts, 2);
  assert.throws(
    () => loadConfig({ ...base, PI_WORKER_MAX_CI_FIX_ATTEMPTS: "0" }),
    /PI_WORKER_MAX_CI_FIX_ATTEMPTS/,
  );
});

test("loadConfig automatically exposes an accessible Docker-style socket unless disabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-worker-socket-"));
  const socket = join(directory, "docker.sock");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    const automatic = loadConfig({ ...base, PI_WORKER_DOCKER_SOCKET: socket });
    assert.equal(automatic.allowDocker, true);
    assert.equal(automatic.dockerSocket, socket);
    const disabled = loadConfig({
      ...base,
      PI_WORKER_DOCKER_SOCKET: socket,
      PI_WORKER_ALLOW_DOCKER: "0",
    });
    assert.equal(disabled.allowDocker, false);
    assert.equal(disabled.dockerSocket, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadConfig validates the privileged Docker opt-in", () => {
  assert.throws(
    () => loadConfig({ ...base, PI_WORKER_ALLOW_DOCKER: "sometimes" }),
    /PI_WORKER_ALLOW_DOCKER/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        PI_WORKER_ALLOW_DOCKER: "1",
        PI_WORKER_DOCKER_SOCKET: "/definitely/missing/docker.sock",
      }),
    /accessible Unix socket/,
  );
});

test("loadConfig requires repository identity and an explicit base branch", () => {
  assert.throws(() => loadConfig({}), /PI_WORKER_REPOSITORY/);
  assert.throws(() => loadConfig({ PI_WORKER_REPOSITORY: "invalid" }), /owner\/repository/);
  assert.throws(
    () => loadConfig({ PI_WORKER_REPOSITORY: "example/widgets" }),
    /PI_WORKER_BASE_BRANCH/,
  );
});
