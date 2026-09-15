import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cgroupController } from "../src/agent/cgroup.js";
import { AppInstanceError, endpointEnvironmentName, startAppInstance } from "../src/app-instance/index.js";
import type { WorkerConfig } from "../src/config.js";
import { config as testConfig } from "./helpers/worker-fixtures.js";

const execFile = promisify(execFileCb);
const launcher = fileURLToPath(new URL("./fixtures/fake-launcher.sh", import.meta.url));
const git = ["-c", "user.email=t@t", "-c", "user.name=t"];

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function fixture(): Promise<{ root: string; tree: string; config: WorkerConfig; options: Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-app-instance-"));
  const tree = join(root, "tree");
  await mkdir(tree);
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: tree });
  await writeFile(join(tree, ".gitignore"), ".auth/\n");
  await writeFile(join(tree, "a.txt"), "a\n");
  await execFile("git", [...git, "add", "-A"], { cwd: tree });
  await execFile("git", [...git, "commit", "-qm", "init"], { cwd: tree });
  const meminfo = join(root, "meminfo");
  await writeFile(meminfo, "MemTotal:       32505856 kB\nMemAvailable:   16000000 kB\n");
  const config = { ...testConfig(root), appStartTimeoutSeconds: 20 };
  const options = { issueNumber: 42, runId: "run-1", cgroups: cgroupController(null), meminfoPath: meminfo, intervalMs: 20, launchEnvironment: { FAKE_WWW: join(root, "www") } };
  return { root, tree, config, options };
}

function manifestFor(port: number, extra: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    launch: { argv: [launcher], env: { FAKE_PORT: String(port) } },
    readiness: { endpoints: { frontend: `http://127.0.0.1:${port}` }, paths: { frontend: "/" } },
    ...extra,
  };
}

test("startAppInstance launches, waits for readiness, records, exposes env and stops the launcher", async () => {
  const { root, tree, config, options } = await fixture();
  const port = await freePort();
  const instance = await startAppInstance(config, tree, manifestFor(port), options as never);
  try {
    assert.deepEqual(instance.endpoints, { frontend: `http://127.0.0.1:${port}` });
    assert.equal(instance.storageState, null);
    assert.ok(instance.readinessMs >= 0);
    const env = instance.environment();
    assert.equal(env.PI_QA_INSTANCE, instance.dir);
    assert.equal(env.PI_QA_RUN_ID, "run-1");
    assert.equal(env.PI_QA_ENDPOINT_FRONTEND, `http://127.0.0.1:${port}`);
    assert.equal(env.PI_QA_STORAGE_STATE, undefined);
    const record = JSON.parse(await readFile(join(instance.dir, "instance.json"), "utf8"));
    assert.equal(record.fingerprint, instance.fingerprint);
    assert.equal(record.endpoints.frontend, `http://127.0.0.1:${port}`);
  } finally {
    await instance.stop();
  }
  assert.match(await readFile(join(instance.dir, "launch.log"), "utf8"), /launcher stopped/);
  await rm(root, { recursive: true, force: true });
});

test("the memory guard refuses to launch below the floor", async () => {
  const { root, tree, config, options } = await fixture();
  await writeFile(options.meminfoPath as string, "MemAvailable:   2000000 kB\n");
  await assert.rejects(
    startAppInstance({ ...config, appMinAvailableMb: 4096 }, tree, manifestFor(1), options as never),
    (error: unknown) => error instanceof AppInstanceError && error.phase === "memory" && /1953 MB available, 4096 MB required/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

// Static endpoints resolve instantly, so a launcher that dies is noticed by the readiness poll.
test("a launcher that exits fails the readiness phase with its log tail", async () => {
  const { root, tree, config, options } = await fixture();
  const port = await freePort();
  await assert.rejects(
    startAppInstance(config, tree, manifestFor(port), { ...options, launchEnvironment: { ...(options.launchEnvironment as object), FAKE_FAIL: "1" } } as never),
    (error: unknown) => error instanceof AppInstanceError && error.phase === "readiness" && /exit code 3/.test(error.message) && /boom: dependency missing/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("auth setup runs against the resolved endpoint and the gitignored storage state is copied", async () => {
  const { root, tree, config, options } = await fixture();
  const port = await freePort();
  await writeFile(join(tree, "setup.sh"), '#!/usr/bin/env bash\nmkdir -p .auth && printf \'{"origin":"%s","role":"%s"}\' "$BASE_URL" "$ROLE" > .auth/state.json\n', { mode: 0o755 });
  const manifest = manifestFor(port, { auth: { storageState: ".auth/state.json", setup: { argv: ["./setup.sh"], env: { ROLE: "ContentEditor" }, envFromEndpoints: { BASE_URL: "frontend" } } } });
  const instance = await startAppInstance(config, tree, manifest, options as never);
  try {
    assert.equal(instance.storageState, join(instance.dir, "storage-state.json"));
    assert.deepEqual(JSON.parse(await readFile(instance.storageState!, "utf8")), { origin: `http://127.0.0.1:${port}`, role: "ContentEditor" });
    assert.equal(instance.environment().PI_QA_STORAGE_STATE, instance.storageState);
  } finally {
    await instance.stop();
  }
  await rm(root, { recursive: true, force: true });
});

test("a storage state git would list is rejected in the auth phase", async () => {
  const { root, tree, config, options } = await fixture();
  const port = await freePort();
  await writeFile(join(tree, "setup.sh"), "#!/usr/bin/env bash\nprintf '{}' > tracked-state.json\n", { mode: 0o755 });
  const manifest = manifestFor(port, { auth: { storageState: "tracked-state.json", setup: { argv: ["./setup.sh"] } } });
  await assert.rejects(
    startAppInstance(config, tree, manifest, options as never),
    (error: unknown) => error instanceof AppInstanceError && error.phase === "auth" && /must be gitignored/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("ensureCurrent relaunches when the tree changed and is a no-op otherwise", async () => {
  const { root, tree, config, options } = await fixture();
  const port = await freePort();
  const instance = await startAppInstance(config, tree, manifestFor(port), options as never);
  try {
    assert.equal(await instance.ensureCurrent(), false);
    await writeFile(join(tree, "a.txt"), "b\n");
    assert.equal(await instance.ensureCurrent(), true);
    assert.match(await readFile(join(instance.dir, "launch.log"), "utf8"), /launcher stopped/);
    assert.deepEqual(instance.endpoints, { frontend: `http://127.0.0.1:${port}` });
  } finally {
    await instance.stop();
  }
  await rm(root, { recursive: true, force: true });
});

test("endpoint environment names are upper-cased identifiers", () => {
  assert.equal(endpointEnvironmentName("frontend"), "PI_QA_ENDPOINT_FRONTEND");
  assert.equal(endpointEnvironmentName("cms-host"), "PI_QA_ENDPOINT_CMS_HOST");
});
