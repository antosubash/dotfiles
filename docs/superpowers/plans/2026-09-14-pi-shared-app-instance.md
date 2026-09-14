# pi shared app instance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker launches a repository's app once per job run from its QA manifest, shares it across the visual stage and the independent verifier, kills every agent-spawned process by cgroup, pushes conflict resolutions before verifying them, and keeps per-repository notes across runs.

**Architecture:** A new `src/app-instance/` package owns launch → endpoints → readiness → auth → stop, bound to a child cgroup of the worker's own systemd cgroup (`src/agent/cgroup.ts`, also used to fence every bash call). A stage wrapper (`src/worker/app-stage.ts`) gives the flows one instance for all browser stages; prompts describe the running instance instead of launch procedures. `src/project-memory.ts` renders a capped, secret-filtered index of `<dataDir>/memory/*.md` into prompts.

**Tech Stack:** Node 24 (`node:test`, `node:child_process`, `node:http`/`node:https`), TypeScript ESM, systemd user units, cgroup v2 (`cgroup.kill`), `aspire describe --format Json`, `playwright-cli`.

**Spec:** `docs/superpowers/specs/2026-09-14-pi-shared-app-instance-design.md`

## Global Constraints

- Every source and test file stays ≤ 300 lines (`docs/superpowers/plans/2026-09-06-pi-300-line-split.md` is the standing rule); split before crossing it.
- `npm run check` (tsc + `node --test`) is the only gate; run it before every commit. Baseline: 174 tests, 172 pass, 2 skipped.
- All paths below are relative to `pi/github-issue-worker/`. Run commands from that directory.
- Repositories without a manifest `launch` keep today's behaviour end to end; every new branch is behind `manifest?.launch`.
- Never render secrets into prompts; the memory index is secret-filtered (spec E).
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu`. Before each commit: `git status --porcelain | grep -E '\.env\b|\.pem|credentials' | grep -v '\.env\.example'` must print nothing.
- Branch: `worktree-pi-no-sandbox` (PR #19). Do not force-push.
- Timeouts, sizes and names are the spec's: `PI_WORKER_APP_START_TIMEOUT` default `900`, `PI_WORKER_APP_MIN_AVAILABLE_MB` default `4096`, memory files `^[a-z0-9][a-z0-9-]{0,63}\.md$`, ≤ 4096 bytes each, ≤ 40 files, index ≤ 6144 bytes, env names `PI_QA_INSTANCE`, `PI_QA_ENDPOINT_<KEY>`, `PI_QA_STORAGE_STATE`, `PI_QA_RUN_ID`.

---

### Task 1: cgroup controller

**Files:**
- Create: `src/agent/cgroup.ts`
- Test: `test/cgroup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CgroupController {
    readonly root: string | null;
    available(): boolean;
    createChild(name: string): Promise<string | null>;   // child dir, null when unavailable
    procs(childDir: string): Promise<number[]>;
    killAndRemove(childDir: string, timeoutMs?: number): Promise<void>;
    sweepChildren(prefixes: readonly string[]): Promise<string[]>; // removed child names
  }
  export function ownCgroupPath(procSelfCgroup?: string, sysfs?: string): string | null;
  export function cgroupController(root: string | null): CgroupController;
  export function wrapInCgroup(childDir: string | null, argv: readonly string[]): string[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/cgroup.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cgroupController, ownCgroupPath, wrapInCgroup } from "../src/agent/cgroup.js";

test("ownCgroupPath maps the v2 line of /proc/self/cgroup under the sysfs root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cgroup-"));
  const proc = join(root, "cgroup");
  await writeFile(proc, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi.service\n");
  assert.equal(ownCgroupPath(proc, "/sys/fs/cgroup"), "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/pi.service");
  await writeFile(proc, "12:memory:/legacy\n");
  assert.equal(ownCgroupPath(proc, "/sys/fs/cgroup"), null);
  assert.equal(ownCgroupPath(join(root, "missing"), "/sys/fs/cgroup"), null);
  await rm(root, { recursive: true, force: true });
});

test("an unavailable controller is a no-op that never throws", async () => {
  const controller = cgroupController(null);
  assert.equal(controller.available(), false);
  assert.equal(await controller.createChild("bash-1"), null);
  assert.deepEqual(await controller.sweepChildren(["bash-", "qa-"]), []);
  assert.deepEqual(wrapInCgroup(null, ["bash", "-c", "true"]), ["bash", "-c", "true"]);
});

test("a controller rooted at a plain directory creates, lists and removes children (kill file is written)", async () => {
  // A temp dir stands in for the worker's cgroup: cgroup.procs/cgroup.kill are ordinary files here, which
  // is enough to prove the bookkeeping; the real kill is covered by the opt-in smoke test below.
  const root = await mkdtemp(join(tmpdir(), "pi-cgroup-root-"));
  await writeFile(join(root, "cgroup.kill"), "");
  const controller = cgroupController(root);
  assert.equal(controller.available(), true);
  const child = await controller.createChild("bash-7");
  assert.equal(child, join(root, "bash-7"));
  await writeFile(join(child!, "cgroup.procs"), "");
  await writeFile(join(child!, "cgroup.kill"), "");
  assert.deepEqual(await controller.procs(child!), []);
  await controller.killAndRemove(child!);
  assert.equal(await readFile(join(root, "bash-7", "cgroup.procs"), "utf8").catch(() => "gone"), "gone");
  for (const name of ["bash-1", "qa-abc", "other"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "cgroup.procs"), "");
    await writeFile(join(root, name, "cgroup.kill"), "");
  }
  assert.deepEqual((await controller.sweepChildren(["bash-", "qa-"])).sort(), ["bash-1", "qa-abc"]);
  await rm(root, { recursive: true, force: true });
});

test("wrapInCgroup moves the shell into the child before exec", () => {
  const argv = wrapInCgroup("/sys/fs/cgroup/x/bash-1", ["bash", "-c", "echo hi"]);
  assert.equal(argv[0], "sh");
  assert.match(argv[2], /echo \$\$ > "\$1\/cgroup\.procs"/);
  assert.match(argv[2], /exec "\$@"/);
  assert.deepEqual(argv.slice(3), ["sh", "/sys/fs/cgroup/x/bash-1", "bash", "-c", "echo hi"]);
});

// Real kill: needs a writable cgroup, i.e. a systemd user unit. Run with
// PI_WORKER_CGROUP_SMOKE=1 systemd-run --user --collect --wait --pipe -p Delegate=yes npx tsx --test test/cgroup.test.ts
test("a setsid tree inside a child cgroup is killed by killAndRemove", { skip: process.env.PI_WORKER_CGROUP_SMOKE !== "1" }, async () => {
  const { spawn } = await import("node:child_process");
  const controller = cgroupController(ownCgroupPath());
  assert.equal(controller.available(), true);
  const child = (await controller.createChild("test-smoke"))!;
  const proc = spawn(wrapInCgroup(child, ["bash", "-c", "setsid bash -c 'sleep 300 & sleep 300 & wait' & sleep 300"])[0],
    wrapInCgroup(child, ["bash", "-c", "setsid bash -c 'sleep 300 & sleep 300 & wait' & sleep 300"]).slice(1), { stdio: "ignore", detached: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok((await controller.procs(child)).length >= 3);
  await controller.killAndRemove(child);
  assert.deepEqual(await controller.procs(child).catch(() => []), []);
  proc.kill("SIGKILL");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/cgroup.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/cgroup.js'`

- [ ] **Step 3: Implement `src/agent/cgroup.ts`**

```ts
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The worker runs as a systemd user service and owns its cgroup subtree. Fencing every agent bash call
 * and every launched app instance in a child cgroup means `setsid`, `nohup`, double forks and
 * orchestrator-spawned children all stay visible and all die with `cgroup.kill`. Where that is not
 * available (no cgroup v2, not under systemd, tests) every function is a no-op and process groups remain
 * the only guarantee, exactly as before.
 */
export interface CgroupController {
  readonly root: string | null;
  available(): boolean;
  createChild(name: string): Promise<string | null>;
  procs(childDir: string): Promise<number[]>;
  killAndRemove(childDir: string, timeoutMs?: number): Promise<void>;
  sweepChildren(prefixes: readonly string[]): Promise<string[]>;
}

/** The unified (v2) cgroup of this process, as a directory under the cgroup filesystem, or null. */
export function ownCgroupPath(procSelfCgroup = "/proc/self/cgroup", sysfs = "/sys/fs/cgroup"): string | null {
  let content: string;
  try {
    content = readFileSync(procSelfCgroup, "utf8");
  } catch {
    return null;
  }
  const line = content.split("\n").find((entry) => entry.startsWith("0::/"));
  return line ? join(sysfs, line.slice(3)) : null;
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return existsSync(join(dir, "cgroup.kill"));
  } catch {
    return false;
  }
}

/** Runs `argv` after moving the shell into `childDir`, so every descendant starts inside the cgroup. */
export function wrapInCgroup(childDir: string | null, argv: readonly string[]): string[] {
  if (!childDir) return [...argv];
  return ["sh", "-c", 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"', "sh", childDir, ...argv];
}

export function cgroupController(root: string | null): CgroupController {
  const available = root !== null && writable(root);
  const procs = async (childDir: string): Promise<number[]> =>
    (await readFile(join(childDir, "cgroup.procs"), "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => Number.parseInt(line, 10));
  const killAndRemove = async (childDir: string, timeoutMs = 10_000): Promise<void> => {
    if (!available) return;
    if (!existsSync(childDir)) return;
    await writeFile(join(childDir, "cgroup.kill"), "1").catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    while ((await procs(childDir).catch(() => [])).length > 0) {
      if (Date.now() >= deadline) throw new Error(`cgroup ${childDir} still has processes after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await rm(childDir, { recursive: false, force: true }).catch(() => undefined);
  };
  return {
    root,
    available: () => available,
    async createChild(name) {
      if (!available) return null;
      const dir = join(root!, name);
      await mkdir(dir);
      return dir;
    },
    procs,
    killAndRemove,
    async sweepChildren(prefixes) {
      if (!available) return [];
      const removed: string[] = [];
      for (const entry of await readdir(root!, { withFileTypes: true })) {
        if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
        await killAndRemove(join(root!, entry.name));
        removed.push(entry.name);
      }
      return removed;
    },
  };
}
```

Note: `rm` on a cgroup directory must be `rmdir` semantics — `rm(dir, { recursive: false })` calls `rmdir` for directories; cgroupfs refuses to remove a non-empty cgroup, which is the desired failure.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/cgroup.test.ts`
Expected: 4 pass, 1 skipped. Then the smoke: `PI_WORKER_CGROUP_SMOKE=1 systemd-run --user --collect --wait --pipe -p Delegate=yes --working-directory=$PWD -E PATH=$PATH -E HOME=$HOME npx tsx --test test/cgroup.test.ts` — Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/cgroup.ts test/cgroup.test.ts
git commit -m "feat(pi): cgroup controller — fence and kill process trees by cgroup

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 2: bash calls run in a child cgroup; MSBuild node reuse off

**Files:**
- Modify: `src/agent/process-group.ts:104-215` (`BashOperationOptions`, `createBashOperations`)
- Modify: `src/agent/isolation.ts:84-90` (pass the controller)
- Modify: `src/pi-agent.ts` (owns a controller; export)
- Test: `test/direct-bash.test.ts` (add cases)

**Interfaces:**
- Consumes: `CgroupController`, `wrapInCgroup` (Task 1).
- Produces: `BashOperationOptions.cgroups?: CgroupController`; `IsolationOptions.cgroups?: CgroupController`; `PiAgentRunner` constructor `(config, dependencies?: { cgroups?: CgroupController })`; `AgentRunOptions.environment?: NodeJS.ProcessEnv` (merged into `environmentOverrides` after `DOCKER_HOST`).

- [ ] **Step 1: Write the failing tests**

Append to `test/direct-bash.test.ts` (it already builds `createBashOperations(file, { sandbox: false })` fixtures; reuse its `exec` helper pattern):

```ts
test("agent bash never reuses MSBuild nodes or the msbuild server", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "pi-bash-")), "pgid");
  const bash = createBashOperations(file, { sandbox: false });
  let out = "";
  await bash.exec('printf "%s %s" "$MSBUILDNODEREUSE" "$DOTNET_CLI_USE_MSBUILD_SERVER"', tmpdir(), { onData: (c: string) => { out += c; }, signal: new AbortController().signal, timeout: 10 });
  assert.equal(out, "0 0");
});

test("a per-run environment reaches the command and cannot override the credential scrub", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "pi-bash-")), "pgid");
  const bash = createBashOperations(file, { sandbox: false, environmentOverrides: { PI_QA_INSTANCE: "/tmp/i", PI_QA_ENDPOINT_FRONTEND: "http://localhost:3005" } });
  let out = "";
  await bash.exec('printf "%s %s" "$PI_QA_INSTANCE" "$PI_QA_ENDPOINT_FRONTEND"', tmpdir(), { onData: (c: string) => { out += c; }, signal: new AbortController().signal, timeout: 10 });
  assert.equal(out, "/tmp/i http://localhost:3005");
});

test("each bash call gets its own child cgroup and it is removed afterwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bash-cg-"));
  await writeFile(join(root, "cgroup.kill"), "");
  const created: string[] = [];
  const cgroups = {
    root, available: () => true,
    createChild: async (name: string) => { const dir = join(root, name); await mkdir(dir); await writeFile(join(dir, "cgroup.procs"), ""); created.push(name); return dir; },
    procs: async () => [],
    killAndRemove: async (dir: string) => { await rm(dir, { recursive: true, force: true }); },
    sweepChildren: async () => [],
  };
  const file = join(root, "pgid");
  const bash = createBashOperations(file, { sandbox: false, cgroups });
  await bash.exec("true", tmpdir(), { onData: () => undefined, signal: new AbortController().signal, timeout: 10 });
  await bash.exec("true", tmpdir(), { onData: () => undefined, signal: new AbortController().signal, timeout: 10 });
  assert.deepEqual(created, ["bash-1", "bash-2"]);
  assert.deepEqual((await readdir(root)).filter((n) => n.startsWith("bash-")), []);
});

test("processes still alive in the call's cgroup reject the call after a cgroup kill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bash-cg-"));
  await writeFile(join(root, "cgroup.kill"), "");
  let killed = 0;
  const cgroups = {
    root, available: () => true,
    createChild: async (name: string) => { const dir = join(root, name); await mkdir(dir); await writeFile(join(dir, "cgroup.procs"), ""); return dir; },
    procs: async () => (killed ? [] : [4242]),
    killAndRemove: async (dir: string) => { killed += 1; await rm(dir, { recursive: true, force: true }); },
    sweepChildren: async () => [],
  };
  const bash = createBashOperations(join(root, "pgid"), { sandbox: false, cgroups });
  await assert.rejects(
    bash.exec("true", tmpdir(), { onData: () => undefined, signal: new AbortController().signal, timeout: 10 }),
    /left background processes running/,
  );
  assert.equal(killed, 1);
});
```

Add the imports the file lacks (`mkdir`, `readdir`, `rm`, `writeFile` from `node:fs/promises`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test test/direct-bash.test.ts`
Expected: the first fails on `" "` ≠ `"0 0"`; the cgroup ones fail with a TypeScript error on `cgroups` / no `bash-1` created.

- [ ] **Step 3: Implement**

In `src/agent/process-group.ts`:

```ts
import { cgroupController, wrapInCgroup, type CgroupController } from "./cgroup.js";

/** Build tooling must not leave helpers behind: nodes die with their call anyway, these flags stop the retries. */
const BUILD_TOOLING_ENVIRONMENT = { MSBUILDNODEREUSE: "0", DOTNET_CLI_USE_MSBUILD_SERVER: "0" } as const;

export interface BashOperationOptions {
  sandbox: boolean;
  shutdownSignal?: AbortSignal;
  environmentOverrides?: NodeJS.ProcessEnv;
  /** Child-cgroup fencing; defaults to an unavailable (no-op) controller. */
  cgroups?: CgroupController;
}

export function createBashOperations(
  processGroupFile: string,
  { sandbox, shutdownSignal, environmentOverrides = {}, cgroups = cgroupController(null) }: BashOperationOptions,
): BashOperations {
  let sequence = 0;
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const wrappedCommand = sandbox ? await SandboxManager.wrapWithSandbox(command) : command;
      sequence += 1;
      const childCgroup = await cgroups.createChild(`bash-${sequence}`);
      const [executable, ...args] = wrapInCgroup(childCgroup, ["bash", "-c", wrappedCommand]);
      return await new Promise((resolveResult, reject) => {
        const child = spawn(executable, args, {
          cwd,
          detached: true,
          env: { ...sandboxEnvironment(), ...BUILD_TOOLING_ENVIRONMENT, ...environmentOverrides },
          stdio: ["ignore", "pipe", "pipe"],
        });
        // … existing pid/process-group-file handling unchanged …
        const stopCurrentProcessGroup = () => {
          stopPromise ??= (async () => {
            await stopTrackedProcessGroup(processGroupFile);
            if (childCgroup) await cgroups.killAndRemove(childCgroup);
          })();
          return stopPromise;
        };
        // … in child.on("close"), replace the leftover check:
        const pid = child.pid;
        const leftover = childCgroup
          ? (await cgroups.procs(childCgroup).catch(() => [])).length > 0
          : pid !== undefined && isProcessGroupAlive(pid);
        if (leftover) {
          await stopCurrentProcessGroup();
          reject(new Error("bash command left background processes running"));
          return;
        }
        if (childCgroup) await cgroups.killAndRemove(childCgroup);
        if (pid !== undefined) clearTrackedProcessGroupFile(processGroupFile, pid);
        resolveResult({ exitCode: code });
      });
    },
  };
}
```

Keep the existing timeout/abort/`error` branches; they all call `stopCurrentProcessGroup()`, which now also kills the cgroup. Update the doc comment at the top of `BashOperationOptions` to say "detached process group **and child cgroup**".

In `src/agent/isolation.ts`: add `cgroups?: CgroupController` to `IsolationOptions` and pass `cgroups: options.cgroups` plus `environmentOverrides: { ...(dockerAccess && config.dockerSocket ? { DOCKER_HOST: \`unix://${config.dockerSocket}\` } : {}), ...(options.environment ?? {}) }` where `environment?: NodeJS.ProcessEnv` is a new `IsolationOptions` field.

In `src/pi-agent.ts`: `AgentRunOptions.environment?: NodeJS.ProcessEnv`; constructor `constructor(private readonly config: WorkerConfig, private readonly dependencies: { cgroups?: CgroupController } = {})`; the `openIsolation` call passes `cgroups: this.dependencies.cgroups ?? cgroupController(ownCgroupPath())` and `environment: options.environment`. Export `cgroupController`, `ownCgroupPath` from `src/pi-agent.ts` next to the other re-exports.

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test test/direct-bash.test.ts test/process-groups.test.ts test/isolation.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/process-group.ts src/agent/isolation.ts src/pi-agent.ts test/direct-bash.test.ts
git commit -m "feat(pi): every agent bash call runs in its own child cgroup; leftovers die by cgroup.kill

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 3: units delegate their cgroup; stale children are swept at start

**Files:**
- Modify: `systemd/pi-issue-worker@.service`, `systemd/pi-issue-worker-supervisor.service` (add `Delegate=yes` after `KillMode=control-group`)
- Modify: `src/index.ts:18-35` (sweep before the first tick)
- Test: `test/systemd.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("systemd units delegate their cgroup subtree so the worker can fence and kill agent process trees", async () => {
  for (const path of [supervisorUnit, profileUnit]) {
    assert.match(await readFile(path, "utf8"), /^Delegate=yes$/m);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/systemd.test.ts` — Expected: FAIL (no `Delegate=`).

- [ ] **Step 3: Implement**

Add `Delegate=yes` to the `[Service]` section of both units, directly under `KillMode=control-group`. In `src/index.ts` `main()`, after `const config = loadConfig();`:

```ts
import { cgroupController, ownCgroupPath } from "./agent/cgroup.js";
// …
const cgroups = cgroupController(ownCgroupPath());
for (const name of await cgroups.sweepChildren(["bash-", "qa-"])) {
  console.error(`${new Date().toISOString()} removed stale child cgroup ${name}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test test/systemd.test.ts` — Expected: pass. `npm run check` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add systemd/pi-issue-worker@.service systemd/pi-issue-worker-supervisor.service src/index.ts test/systemd.test.ts
git commit -m "feat(pi): units delegate their cgroup; stale bash-/qa- child cgroups are swept at start

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 4: configuration for the app instance

**Files:**
- Modify: `src/config.ts` (`WorkerConfig`, `loadConfig`), `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `WorkerConfig.appStartTimeoutSeconds: number` (default 900), `WorkerConfig.appMinAvailableMb: number` (default 4096).

- [ ] **Step 1: Write the failing test**

```ts
test("app instance limits default to 900 s and 4096 MB and accept overrides", () => {
  const base = { HOME: "/tmp/h", PI_WORKER_REPOSITORY: "example/widgets", PI_WORKER_BASE_BRANCH: "main", PI_WORKER_DATA_DIR: "/tmp/h/d" };
  assert.equal(loadConfig(base).appStartTimeoutSeconds, 900);
  assert.equal(loadConfig(base).appMinAvailableMb, 4096);
  assert.equal(loadConfig({ ...base, PI_WORKER_APP_START_TIMEOUT: "120", PI_WORKER_APP_MIN_AVAILABLE_MB: "1024" }).appStartTimeoutSeconds, 120);
  assert.equal(loadConfig({ ...base, PI_WORKER_APP_MIN_AVAILABLE_MB: "1024" }).appMinAvailableMb, 1024);
  assert.throws(() => loadConfig({ ...base, PI_WORKER_APP_START_TIMEOUT: "0" }), /PI_WORKER_APP_START_TIMEOUT/);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/config.test.ts` — Expected: FAIL, property missing.

- [ ] **Step 3: Implement** — in `WorkerConfig` add, with doc comments:

```ts
/** Seconds allowed for launch + endpoint resolution + readiness of a harness-owned app instance. */
appStartTimeoutSeconds: number;
/** Refuse to launch an app instance when MemAvailable is below this many MB: a clear block, not ten minutes of swap. */
appMinAvailableMb: number;
```

and in `loadConfig`'s returned object:

```ts
appStartTimeoutSeconds: positiveInteger("PI_WORKER_APP_START_TIMEOUT", env.PI_WORKER_APP_START_TIMEOUT || "", 900),
appMinAvailableMb: positiveInteger("PI_WORKER_APP_MIN_AVAILABLE_MB", env.PI_WORKER_APP_MIN_AVAILABLE_MB || "", 4096),
```

`.env.example` gains, next to the QA manifest entry:

```dotenv
# Harness-owned app instance (only when .pi-worker/qa.json declares `launch`)
# PI_WORKER_APP_START_TIMEOUT=900        # seconds: launch + endpoints + readiness
# PI_WORKER_APP_MIN_AVAILABLE_MB=4096    # refuse to launch below this MemAvailable
```

- [ ] **Step 4: Run** — `npx tsx --test test/config.test.ts` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example test/config.test.ts
git commit -m "feat(pi): app instance start timeout and memory floor settings

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 5: manifest `readiness.endpoints`

**Files:**
- Modify: `src/qa-manifest.ts:24-32` (`QaReadiness`), the readiness parsing block
- Test: `test/qa-manifest.test.ts`

**Interfaces:**
- Produces: `QaReadiness.endpoints?: Record<string, string>` — static loopback URLs (`http://localhost:3000`, `https://127.0.0.1:8443/base`), validated by `SAFE_LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/`.

- [ ] **Step 1: Write the failing tests** (the file's `fixture()` writes a manifest and returns the root; follow it)

```ts
test("readiness.endpoints declares static loopback URLs and rejects anything else", async () => {
  const root = await fixture();
  await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify({
    version: 1, launch: { argv: ["./run.sh"] },
    readiness: { endpoints: { frontend: "http://localhost:3000", api: "https://127.0.0.1:8443/api" }, paths: { frontend: "/", api: "/health" } },
  }));
  const manifest = await loadQaManifest(root, ".pi-worker/qa.json");
  assert.deepEqual(manifest?.readiness?.endpoints, { frontend: "http://localhost:3000", api: "https://127.0.0.1:8443/api" });
  for (const bad of ["http://example.com", "ftp://localhost", "http://localhost:3000/../x", "http://localhost:3000 x"]) {
    await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify({ version: 1, readiness: { endpoints: { frontend: bad } } }));
    await assert.rejects(loadQaManifest(root, ".pi-worker/qa.json"), /readiness\.endpoints/);
  }
});
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/qa-manifest.test.ts` — Expected: FAIL (`endpoints` is an unknown key).

- [ ] **Step 3: Implement** — add the field with the doc comment "Static URLs for launchers that are not Aspire; keys are endpoint names used by `readiness.paths` and `auth.setup.envFromEndpoints`." In the readiness block, next to `resources`/`paths`:

```ts
const SAFE_LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;
// inside the readiness parser:
onlyKeys(readiness, ["resources", "paths", "endpoints"], "QA manifest readiness");
if (readiness.endpoints !== undefined) {
  parsed.endpoints = parseEnv(readiness.endpoints, "QA manifest readiness.endpoints", SAFE_LOOPBACK_URL);
  for (const url of Object.values(parsed.endpoints)) {
    if (url.includes("/../")) throw new Error("QA manifest readiness.endpoints must not traverse");
  }
}
```

(`parseEnv(value, context, valuePattern)` already validates keys against `SAFE_ENV_NAME` and values against the pattern; reuse it.)

- [ ] **Step 4: Run** — `npx tsx --test test/qa-manifest.test.ts` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/qa-manifest.ts test/qa-manifest.test.ts
git commit -m "feat(pi): QA manifest readiness.endpoints for non-Aspire launchers

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 6: one UI-surface heuristic

**Files:**
- Create: `src/ui-surface.ts`
- Modify: `src/qa-verification.ts:148-151` (use it)
- Test: `test/ui-surface.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isUiSurface(issue: Pick<GitHubIssue, "title" | "body">, changedPaths: string, untrackedPaths: string): boolean;
  export async function worktreeUiSurface(issue: Pick<GitHubIssue, "title" | "body">, worktree: string, baseBranch: string): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isUiSurface } from "../src/ui-surface.js";

test("UI surface is detected from issue text or changed paths", () => {
  const issue = { title: "Speed up import", body: "Batch the inserts" };
  assert.equal(isUiSurface(issue, "src/import/batch.ts\n", ""), false);
  assert.equal(isUiSurface(issue, "frontend/apps/web/src/routes/admin.tsx\n", ""), true);
  assert.equal(isUiSurface({ title: "Fix the settings dialog", body: "" }, "", ""), true);
  assert.equal(isUiSurface(issue, "", "app/pages/new.vue\n"), true);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/ui-surface.test.ts` — Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// src/ui-surface.ts
import { execFile } from "./exec.js";
import type { GitHubIssue } from "./types.js";

const UI_SURFACE = /\b(?:ui|ux|frontend|front-end|layout|responsive|browser|figma|page|screen|form|button|dialog|modal|component)\b|(?:^|\/)(?:app|frontend|client|views?|routes?|pages?|components?|templates?|static|ui)\/|\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)\b/im;

/** The one heuristic the verifier and the stage wrapper share, so both agree on whether a browser stage is needed. */
export function isUiSurface(issue: Pick<GitHubIssue, "title" | "body">, changedPaths: string, untrackedPaths: string): boolean {
  return UI_SURFACE.test(`${issue.title}\n${issue.body}\n${changedPaths}\n${untrackedPaths}`);
}

export async function worktreeUiSurface(issue: Pick<GitHubIssue, "title" | "body">, worktree: string, baseBranch: string): Promise<boolean> {
  const changed = (await execFile("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", `origin/${baseBranch}`], { cwd: worktree })).stdout;
  const untracked = (await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree })).stdout;
  return isUiSurface(issue, changed, untracked);
}
```

In `src/qa-verification.ts` replace the inline `changed`/`untracked`/`ui` computation with `const ui = await worktreeUiSurface(issue, worktree, this.config.baseBranch);` and delete the now-unused regex.

- [ ] **Step 4: Run** — `npx tsx --test test/ui-surface.test.ts test/qa-verification.test.ts test/verification.test.ts` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui-surface.ts src/qa-verification.ts test/ui-surface.test.ts
git commit -m "refactor(pi): one UI-surface heuristic shared by the verifier and the stage wrapper

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 7: endpoint resolution (Aspire describe + static)

**Files:**
- Create: `src/app-instance/endpoints.ts`
- Test: `test/app-instance-endpoints.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AspireResource { displayName: string; state?: string; urls?: Array<{ name?: string; url: string }> }
  export type Endpoints = Record<string, string>;
  export type DescribeAspire = (worktree: string, apphost: string) => Promise<AspireResource[]>;
  export const describeAspire: DescribeAspire;                 // runs `aspire describe --apphost <apphost> --format Json --non-interactive`
  export function endpointsFromAspire(resources: AspireResource[], wanted: Record<string, string>, required: readonly string[]): { endpoints: Endpoints; missing: string[] };
  export async function resolveEndpoints(manifest: QaManifest, worktree: string, options: { describe: DescribeAspire; deadline: number; intervalMs: number; launcherExited: () => string | null }): Promise<Endpoints>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { endpointsFromAspire, resolveEndpoints } from "../src/app-instance/endpoints.js";

const running = (displayName: string, url: string) => ({ displayName, state: "Running", urls: [{ name: "http", url }] });

test("endpointsFromAspire maps manifest keys to running resources' first URL", () => {
  const { endpoints, missing } = endpointsFromAspire(
    [running("geowiki-frontend", "http://localhost:3005"), { displayName: "geowiki-api", state: "Starting", urls: [] }, { displayName: "geowiki-frontend-installer", state: "Finished" }],
    { frontend: "geowiki-frontend", api: "geowiki-api" },
    ["frontend", "api"],
  );
  assert.deepEqual(endpoints, { frontend: "http://localhost:3005" });
  assert.deepEqual(missing, ["api"]);
});

test("resolveEndpoints polls describe until every required key is running", async () => {
  let calls = 0;
  const describe = async () => {
    calls += 1;
    return calls < 3
      ? [running("geowiki-frontend", "http://localhost:3005")]
      : [running("geowiki-frontend", "http://localhost:3005"), running("geowiki-api", "https://localhost:44431")];
  };
  const manifest = { version: 1 as const, aspire: { apphost: "App/App.csproj", resources: { frontend: "geowiki-frontend", api: "geowiki-api" } }, readiness: { resources: ["frontend", "api"] } };
  const endpoints = await resolveEndpoints(manifest, "/w", { describe, deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => null });
  assert.deepEqual(endpoints, { frontend: "http://localhost:3005", api: "https://localhost:44431" });
  assert.equal(calls, 3);
});

test("resolveEndpoints fails fast when the launcher exits and on timeout", async () => {
  const manifest = { version: 1 as const, aspire: { apphost: "A.csproj", resources: { api: "x" } } };
  await assert.rejects(resolveEndpoints(manifest, "/w", { describe: async () => [], deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => "exit code 1" }), /launcher exited \(exit code 1\)/);
  await assert.rejects(resolveEndpoints(manifest, "/w", { describe: async () => [], deadline: Date.now() + 20, intervalMs: 5, launcherExited: () => null }), /not running after .*: api/);
});

test("static readiness.endpoints need no resolution", async () => {
  const manifest = { version: 1 as const, readiness: { endpoints: { frontend: "http://localhost:3000" } } };
  assert.deepEqual(await resolveEndpoints(manifest, "/w", { describe: async () => { throw new Error("never"); }, deadline: Date.now() + 100, intervalMs: 5, launcherExited: () => null }), { frontend: "http://localhost:3000" });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/app-instance-endpoints.test.ts` — Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// src/app-instance/endpoints.ts
import { execFile } from "../exec.js";
import type { QaManifest } from "../qa-manifest.js";

export interface AspireResource {
  displayName: string;
  state?: string;
  urls?: Array<{ name?: string; url: string }>;
}
export type Endpoints = Record<string, string>;
export type DescribeAspire = (worktree: string, apphost: string) => Promise<AspireResource[]>;

/** `aspire describe` reports the running AppHost's resources with their allocated URLs; ports are never guessed. */
export const describeAspire: DescribeAspire = async (worktree, apphost) => {
  const { stdout } = await execFile("aspire", ["describe", "--apphost", apphost, "--format", "Json", "--non-interactive"], { cwd: worktree, timeoutMs: 60_000 });
  const parsed = JSON.parse(stdout) as { resources?: AspireResource[] };
  return Array.isArray(parsed.resources) ? parsed.resources : [];
};

export function endpointsFromAspire(resources: AspireResource[], wanted: Record<string, string>, required: readonly string[]): { endpoints: Endpoints; missing: string[] } {
  const endpoints: Endpoints = {};
  const missing: string[] = [];
  for (const [key, displayName] of Object.entries(wanted)) {
    const resource = resources.find((entry) => entry.displayName === displayName);
    const url = resource?.state === "Running" ? resource.urls?.[0]?.url : undefined;
    if (url) endpoints[key] = url;
    else if (required.includes(key)) missing.push(key);
  }
  return { endpoints, missing };
}

export async function resolveEndpoints(
  manifest: QaManifest,
  worktree: string,
  options: { describe: DescribeAspire; deadline: number; intervalMs: number; launcherExited: () => string | null },
): Promise<Endpoints> {
  if (manifest.readiness?.endpoints) return { ...manifest.readiness.endpoints };
  const wanted = manifest.aspire?.resources ?? {};
  const required = manifest.readiness?.resources ?? Object.keys(wanted);
  if (!manifest.aspire) throw new Error("QA manifest declares launch but neither aspire.resources nor readiness.endpoints");
  let lastMissing = required;
  while (true) {
    const exit = options.launcherExited();
    if (exit) throw new Error(`launcher exited (${exit}) before its endpoints were resolved`);
    const resources = await options.describe(worktree, manifest.aspire.apphost).catch(() => [] as AspireResource[]);
    const { endpoints, missing } = endpointsFromAspire(resources, wanted, required);
    if (missing.length === 0) return endpoints;
    lastMissing = missing;
    if (Date.now() >= options.deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new Error(`resources not running after the start timeout: ${lastMissing.join(", ")}`);
}
```

- [ ] **Step 4: Run** — `npx tsx --test test/app-instance-endpoints.test.ts` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/app-instance/endpoints.ts test/app-instance-endpoints.test.ts
git commit -m "feat(pi): resolve app endpoints from aspire describe or static manifest URLs

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 8: readiness probes

**Files:**
- Create: `src/app-instance/readiness.ts`
- Test: `test/app-instance-readiness.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Probe = (url: string) => Promise<number>;           // HTTP status, rejects on connection failure
  export const httpProbe: Probe;                                    // http/https, rejectUnauthorized:false, 10 s, GET, no redirects
  export async function waitForReadiness(endpoints: Endpoints, paths: Record<string, string>, options: { probe: Probe; deadline: number; intervalMs: number; launcherExited: () => string | null }): Promise<Record<string, number>>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { httpProbe, waitForReadiness } from "../src/app-instance/readiness.js";

test("waitForReadiness polls each declared path until it answers 2xx/3xx", async () => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (request.url === "/en") { response.statusCode = hits < 3 ? 503 : 302; response.end(); return; }
    response.statusCode = 200; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const endpoints = { frontend: `http://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}` };
  const statuses = await waitForReadiness(endpoints, { frontend: "/en", api: "/api/health" }, { probe: httpProbe, deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => null });
  assert.deepEqual(statuses, { frontend: 302, api: 200 });
  server.close();
});

test("waitForReadiness reports the failing path on timeout and the launcher exit first", async () => {
  const probe = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(waitForReadiness({ api: "http://127.0.0.1:1" }, { api: "/health" }, { probe, deadline: Date.now() + 30, intervalMs: 5, launcherExited: () => null }), /api http:\/\/127\.0\.0\.1:1\/health: ECONNREFUSED/);
  await assert.rejects(waitForReadiness({ api: "http://127.0.0.1:1" }, { api: "/health" }, { probe, deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => "signal SIGKILL" }), /launcher exited \(signal SIGKILL\)/);
});

test("the probe refuses non-loopback hosts outright", async () => {
  await assert.rejects(httpProbe("https://example.com/"), /only loopback hosts/);
});

test("a path for an unknown endpoint is a manifest error, not a wait", async () => {
  await assert.rejects(waitForReadiness({ api: "http://127.0.0.1:1" }, { frontend: "/" }, { probe: async () => 200, deadline: Date.now() + 100, intervalMs: 5, launcherExited: () => null }), /readiness\.paths names unknown endpoint: frontend/);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/app-instance-readiness.test.ts` — Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// src/app-instance/readiness.ts
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Endpoints } from "./endpoints.js";

export type Probe = (url: string) => Promise<number>;

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * GET without following redirects; a 3xx is "the server is up". The repository's dev certificates are
 * self-signed, so certificate verification is skipped for loopback hosts only — nothing else is ever
 * probed (the manifest admits loopback URLs only, and Aspire allocates loopback endpoints), and the
 * probe reads a status code, never a body it would trust.
 */
export const httpProbe: Probe = (url) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!LOOPBACK.test(target.hostname)) { reject(new Error(`readiness probes only loopback hosts: ${target.hostname}`)); return; }
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: "GET", timeout: 10_000, rejectUnauthorized: false, headers: { accept: "*/*" } },
      (response) => { response.resume(); resolve(response.statusCode ?? 0); },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });

export async function waitForReadiness(
  endpoints: Endpoints,
  paths: Record<string, string>,
  options: { probe: Probe; deadline: number; intervalMs: number; launcherExited: () => string | null },
): Promise<Record<string, number>> {
  const unknown = Object.keys(paths).filter((key) => !(key in endpoints));
  if (unknown.length > 0) throw new Error(`readiness.paths names unknown endpoint: ${unknown.join(", ")}`);
  const statuses: Record<string, number> = {};
  const failures: Record<string, string> = {};
  const pending = new Set(Object.keys(paths));
  while (pending.size > 0) {
    const exit = options.launcherExited();
    if (exit) throw new Error(`launcher exited (${exit}) before readiness`);
    for (const key of [...pending]) {
      const url = `${endpoints[key].replace(/\/$/, "")}${paths[key]}`;
      try {
        const status = await options.probe(url);
        if (status >= 200 && status < 400) { statuses[key] = status; pending.delete(key); }
        else failures[key] = `${key} ${url}: HTTP ${status}`;
      } catch (error) {
        failures[key] = `${key} ${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (pending.size === 0) break;
    if (Date.now() >= options.deadline) throw new Error(`readiness timed out — ${[...pending].map((key) => failures[key]).join("; ")}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  return statuses;
}
```

- [ ] **Step 4: Run** — `npx tsx --test test/app-instance-readiness.test.ts` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/app-instance/readiness.ts test/app-instance-readiness.test.ts
git commit -m "feat(pi): readiness probes for a launched app instance

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 9: the app instance (launch, auth, record, stop, ensureCurrent)

**Files:**
- Create: `src/app-instance/instance.ts` (lifecycle, ≤300 lines), `src/app-instance/auth.ts` (auth setup + storage state), `src/app-instance/index.ts` (re-exports + `AppInstanceService`)
- Modify: `docs/superpowers/specs/2026-09-14-pi-shared-app-instance-design.md` A.5 — "the manifest loader rejects" → "the auth step rejects (`git check-ignore`)"
- Test: `test/app-instance.test.ts`, `test/fixtures/fake-launcher.sh`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 7, 8; `sourceFingerprint(worktree)` from `src/figma-verification.ts`.
- Produces:
  ```ts
  export type AppInstancePhase = "memory" | "launch" | "endpoints" | "readiness" | "auth";
  export class AppInstanceError extends Error { constructor(readonly phase: AppInstancePhase, message: string) }
  export interface AppInstanceSummary { endpoints: Endpoints; storageState: string | null; readinessMs: number }
  export interface AppInstance extends AppInstanceSummary {
    readonly dir: string; readonly runId: string; readonly fingerprint: string;
    environment(): NodeJS.ProcessEnv;      // PI_QA_INSTANCE, PI_QA_RUN_ID, PI_QA_ENDPOINT_<KEY>, PI_QA_STORAGE_STATE
    ensureCurrent(): Promise<boolean>;     // relaunched?
    stop(): Promise<void>;
  }
  export interface AppInstanceOptions {
    issueNumber: number; runId: string; cgroups: CgroupController;
    describe?: DescribeAspire; probe?: Probe; meminfoPath?: string; intervalMs?: number;
    onStarted?: (summary: AppInstanceSummary & { runId: string }) => Promise<void>;   // Task 14 hooks memory notes here
  }
  export async function startAppInstance(config: WorkerConfig, worktree: string, manifest: QaManifest, options: AppInstanceOptions): Promise<AppInstance>;
  export class AppInstanceService { constructor(config: WorkerConfig, cgroups: CgroupController); start(worktree: string, manifest: QaManifest, options: Omit<AppInstanceOptions, "cgroups">): Promise<AppInstance> }
  export function endpointEnvironmentName(key: string): string;   // "frontend" → "PI_QA_ENDPOINT_FRONTEND", "cms-host" → "PI_QA_ENDPOINT_CMS_HOST"
  ```

- [ ] **Step 1: Write the fake launcher and the failing tests**

`test/fixtures/fake-launcher.sh` (chmod +x; it mimics a launcher that serves one endpoint and honours SIGTERM):

```bash
#!/usr/bin/env bash
# Fake app launcher for tests: serves $FAKE_PORT with python's http.server, exits on SIGTERM, optionally fails.
set -u
[ "${FAKE_FAIL:-}" = "1" ] && { echo "boom: dependency missing" >&2; exit 3; }
mkdir -p "${FAKE_WWW:?}"; echo ok > "$FAKE_WWW/index.html"
python3 -m http.server "${FAKE_PORT:?}" --bind 127.0.0.1 --directory "$FAKE_WWW" >/dev/null 2>&1 &
child=$!
trap 'kill $child 2>/dev/null; echo "launcher stopped" ; exit 0' TERM INT
wait $child
```

```ts
// test/app-instance.test.ts
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { cgroupController } from "../src/agent/cgroup.js";
import { AppInstanceError, endpointEnvironmentName, startAppInstance } from "../src/app-instance/index.js";
import { config as testConfig } from "./helpers/worker-fixtures.js";

const execFile = promisify(execFileCb);
const launcher = fileURLToPath(new URL("./fixtures/fake-launcher.sh", import.meta.url));

async function freePort(): Promise<number> {
  return await new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
}

async function worktree(): Promise<{ root: string; tree: string; meminfo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-app-instance-"));
  const tree = join(root, "tree");
  await mkdir(tree);
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: tree });
  await writeFile(join(tree, ".gitignore"), ".auth/\n");
  await writeFile(join(tree, "a.txt"), "a\n");
  await execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: tree });
  await execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: tree });
  const meminfo = join(root, "meminfo");
  await writeFile(meminfo, "MemTotal:       32505856 kB\nMemAvailable:   16000000 kB\n");
  return { root, tree, meminfo };
}

function manifestFor(port: number, extra: Record<string, unknown> = {}) {
  return { version: 1 as const, launch: { argv: [launcher], env: { FAKE_PORT: String(port) } }, readiness: { endpoints: { frontend: `http://127.0.0.1:${port}` }, paths: { frontend: "/" } }, ...extra };
}

test("startAppInstance launches, waits for readiness, records, exposes env and stops the launcher", async () => {
  const { root, tree, meminfo } = await worktree();
  const port = await freePort();
  const config = { ...testConfig(root), appStartTimeoutSeconds: 20 };
  const instance = await startAppInstance(config, tree, manifestFor(port), {
    issueNumber: 42, runId: "run-1", cgroups: cgroupController(null), meminfoPath: meminfo, intervalMs: 20,
    launchEnvironment: { FAKE_WWW: join(root, "www") },
  });
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
  await instance.stop();
  assert.match(await readFile(join(instance.dir, "launch.log"), "utf8"), /launcher stopped/);
  await rm(root, { recursive: true, force: true });
});

test("the memory guard refuses to launch below the floor", async () => {
  const { root, tree, meminfo } = await worktree();
  await writeFile(meminfo, "MemAvailable:   2000000 kB\n");
  await assert.rejects(
    startAppInstance({ ...testConfig(root), appMinAvailableMb: 4096 }, tree, manifestFor(1), { issueNumber: 1, runId: "r", cgroups: cgroupController(null), meminfoPath: meminfo }),
    (error: unknown) => error instanceof AppInstanceError && error.phase === "memory" && /1953 MB available, 4096 MB required/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("a launcher that exits fails the launch phase with its log tail", async () => {
  const { root, tree, meminfo } = await worktree();
  const port = await freePort();
  await assert.rejects(
    startAppInstance({ ...testConfig(root), appStartTimeoutSeconds: 20 }, tree, manifestFor(port), { issueNumber: 1, runId: "r", cgroups: cgroupController(null), meminfoPath: meminfo, intervalMs: 20, launchEnvironment: { FAKE_FAIL: "1", FAKE_WWW: join(root, "www") } }),
    (error: unknown) => error instanceof AppInstanceError && error.phase === "endpoints" && /boom: dependency missing/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("auth setup runs against the resolved endpoint and the gitignored storage state is copied", async () => {
  const { root, tree, meminfo } = await worktree();
  const port = await freePort();
  await writeFile(join(tree, "setup.sh"), '#!/usr/bin/env bash\nmkdir -p .auth && printf \'{"origin":"%s","role":"%s"}\' "$BASE_URL" "$ROLE" > .auth/state.json\n', { mode: 0o755 });
  const manifest = manifestFor(port, { auth: { storageState: ".auth/state.json", setup: { argv: ["./setup.sh"], env: { ROLE: "ContentEditor" }, envFromEndpoints: { BASE_URL: "frontend" } } } });
  const instance = await startAppInstance({ ...testConfig(root), appStartTimeoutSeconds: 20 }, tree, manifest, { issueNumber: 1, runId: "r", cgroups: cgroupController(null), meminfoPath: meminfo, intervalMs: 20, launchEnvironment: { FAKE_WWW: join(root, "www") } });
  assert.equal(instance.storageState, join(instance.dir, "storage-state.json"));
  assert.deepEqual(JSON.parse(await readFile(instance.storageState!, "utf8")), { origin: `http://127.0.0.1:${port}`, role: "ContentEditor" });
  assert.equal(instance.environment().PI_QA_STORAGE_STATE, instance.storageState);
  await instance.stop();
  await rm(root, { recursive: true, force: true });
});

test("a storage state git would list is rejected in the auth phase", async () => {
  const { root, tree, meminfo } = await worktree();
  const port = await freePort();
  await writeFile(join(tree, "setup.sh"), "#!/usr/bin/env bash\nprintf '{}' > tracked-state.json\n", { mode: 0o755 });
  const manifest = manifestFor(port, { auth: { storageState: "tracked-state.json", setup: { argv: ["./setup.sh"] } } });
  await assert.rejects(
    startAppInstance({ ...testConfig(root), appStartTimeoutSeconds: 20 }, tree, manifest, { issueNumber: 1, runId: "r", cgroups: cgroupController(null), meminfoPath: meminfo, intervalMs: 20, launchEnvironment: { FAKE_WWW: join(root, "www") } }),
    (error: unknown) => error instanceof AppInstanceError && error.phase === "auth" && /must be gitignored/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("ensureCurrent relaunches when the tree changed and is a no-op otherwise", async () => {
  const { root, tree, meminfo } = await worktree();
  const port = await freePort();
  const instance = await startAppInstance({ ...testConfig(root), appStartTimeoutSeconds: 20 }, tree, manifestFor(port), { issueNumber: 1, runId: "r", cgroups: cgroupController(null), meminfoPath: meminfo, intervalMs: 20, launchEnvironment: { FAKE_WWW: join(root, "www") } });
  assert.equal(await instance.ensureCurrent(), false);
  await writeFile(join(tree, "a.txt"), "b\n");
  assert.equal(await instance.ensureCurrent(), true);
  assert.match(await readFile(join(instance.dir, "launch.log"), "utf8"), /launcher stopped/);
  assert.deepEqual(instance.endpoints, { frontend: `http://127.0.0.1:${port}` });
  await instance.stop();
  await rm(root, { recursive: true, force: true });
});

test("endpoint environment names are upper-cased identifiers", () => {
  assert.equal(endpointEnvironmentName("frontend"), "PI_QA_ENDPOINT_FRONTEND");
  assert.equal(endpointEnvironmentName("cms-host"), "PI_QA_ENDPOINT_CMS_HOST");
});
```

Note the extra option `launchEnvironment?: NodeJS.ProcessEnv` on `AppInstanceOptions`: test-only plumbing for the fake launcher's `FAKE_WWW`/`FAKE_FAIL`; the flows never pass it. Add it to the interface.

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/app-instance.test.ts` — Expected: module not found.

- [ ] **Step 3: Implement `src/app-instance/auth.ts`**

```ts
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "../exec.js";
import { sandboxEnvironment } from "../agent/sandbox.js";
import { wrapInCgroup } from "../agent/cgroup.js";
import type { QaAuth } from "../qa-manifest.js";
import type { Endpoints } from "./endpoints.js";

/**
 * Runs the repository's declared login setup against THIS instance and copies the resulting Playwright
 * storage state out of the worktree. The worktree file must be gitignored: the verifier's source
 * fingerprint covers tracked and untracked files, so a state git would list invalidates every verdict.
 */
export async function establishAuth(
  auth: QaAuth,
  worktree: string,
  endpoints: Endpoints,
  instanceDir: string,
  options: { cgroupDir: string | null; logFile: string; timeoutMs: number },
): Promise<string> {
  const ignored = await execFile("git", ["check-ignore", "-q", "--", auth.storageState], { cwd: worktree }).then(() => true, () => false);
  if (!ignored) throw new Error(`auth.storageState must be gitignored by the repository: ${auth.storageState}`);
  if (auth.setup) {
    const env: NodeJS.ProcessEnv = { ...sandboxEnvironment(), ...(auth.setup.env ?? {}) };
    for (const [name, key] of Object.entries(auth.setup.envFromEndpoints ?? {})) {
      if (!(key in endpoints)) throw new Error(`auth.setup.envFromEndpoints names unknown endpoint: ${key}`);
      env[name] = endpoints[key];
    }
    const [command, ...args] = wrapInCgroup(options.cgroupDir, auth.setup.argv);
    await execFile(command, args, { cwd: worktree, env, timeoutMs: options.timeoutMs, logFile: options.logFile });
  }
  await mkdir(instanceDir, { recursive: true, mode: 0o700 });
  const copy = join(instanceDir, "storage-state.json");
  await copyFile(resolve(worktree, auth.storageState), copy);
  return copy;
}
```

Check `src/exec.ts`'s `ExecOptions` for a log-file option; if it has none, capture `stdout`/`stderr` from the result and append them to `options.logFile` with `appendFile`, and on failure rethrow with the last 40 lines (`tail(text, 40)` helper below).

- [ ] **Step 4: Implement `src/app-instance/instance.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../config.js";
import { wrapInCgroup, type CgroupController } from "../agent/cgroup.js";
import { sandboxEnvironment } from "../agent/sandbox.js";
import { sourceFingerprint } from "../figma-verification.js";
import type { QaManifest } from "../qa-manifest.js";
import { establishAuth } from "./auth.js";
import { describeAspire, resolveEndpoints, type DescribeAspire, type Endpoints } from "./endpoints.js";
import { httpProbe, waitForReadiness, type Probe } from "./readiness.js";

export type AppInstancePhase = "memory" | "launch" | "endpoints" | "readiness" | "auth";

export class AppInstanceError extends Error {
  constructor(readonly phase: AppInstancePhase, message: string) {
    super(`App instance ${phase} failed: ${message}`);
  }
}

export interface AppInstanceSummary { endpoints: Endpoints; storageState: string | null; readinessMs: number }

export interface AppInstance extends AppInstanceSummary {
  readonly dir: string;
  readonly runId: string;
  readonly fingerprint: string;
  environment(): NodeJS.ProcessEnv;
  ensureCurrent(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface AppInstanceOptions {
  issueNumber: number;
  runId: string;
  cgroups: CgroupController;
  describe?: DescribeAspire;
  probe?: Probe;
  meminfoPath?: string;
  intervalMs?: number;
  launchEnvironment?: NodeJS.ProcessEnv;
  onStarted?: (summary: AppInstanceSummary & { runId: string }) => Promise<void>;
}

export function endpointEnvironmentName(key: string): string {
  return `PI_QA_ENDPOINT_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function tail(text: string, lines = 40): string {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}

async function availableMb(meminfoPath: string): Promise<number | null> {
  const content = await readFile(meminfoPath, "utf8").catch(() => null);
  const match = content?.match(/^MemAvailable:\s+(\d+) kB/m);
  return match ? Math.floor(Number(match[1]) / 1024) : null;
}

interface Launched { child: ChildProcess; cgroupDir: string | null; exit: () => string | null }

function launch(argv: readonly string[], worktree: string, env: NodeJS.ProcessEnv, logFile: string, cgroupDir: string | null): Launched {
  const fd = openSync(logFile, "a");
  const [command, ...args] = wrapInCgroup(cgroupDir, argv);
  const child = spawn(command, args, { cwd: worktree, env, stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  let exit: string | null = null;
  child.on("exit", (code, signal) => { exit = signal ? `signal ${signal}` : `exit code ${code}`; });
  child.on("error", (error) => { exit = error.message; });
  return { child, cgroupDir, exit: () => exit };
}

async function stopLaunched(launched: Launched, cgroups: CgroupController): Promise<void> {
  const { child } = launched;
  if (child.pid && launched.exit() === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 30_000;
    while (launched.exit() === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (launched.exit() === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  if (launched.cgroupDir) await cgroups.killAndRemove(launched.cgroupDir);
}

export async function startAppInstance(config: WorkerConfig, worktree: string, manifest: QaManifest, options: AppInstanceOptions): Promise<AppInstance> {
  if (!manifest.launch) throw new AppInstanceError("launch", "the QA manifest declares no launch");
  const launchSpec = manifest.launch;
  const dir = join(config.dataDir, "instances", `issue-${options.issueNumber}`, options.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const logFile = join(dir, "launch.log");
  const intervalMs = options.intervalMs ?? 3_000;
  const available = await availableMb(options.meminfoPath ?? "/proc/meminfo");
  if (available !== null && available < config.appMinAvailableMb) {
    throw new AppInstanceError("memory", `${available} MB available, ${config.appMinAvailableMb} MB required`);
  }
  const env: NodeJS.ProcessEnv = { ...sandboxEnvironment(), ...(launchSpec.env ?? {}), ...(options.launchEnvironment ?? {}), PI_QA_RUN_ID: options.runId };

  const bringUp = async (): Promise<{ launched: Launched; endpoints: Endpoints; storageState: string | null; readinessMs: number; fingerprint: string }> => {
    const started = Date.now();
    const deadline = started + config.appStartTimeoutSeconds * 1_000;
    const fingerprint = await sourceFingerprint(worktree);
    const cgroupDir = await options.cgroups.createChild(`qa-${options.runId}`);
    const launched = launch(launchSpec.argv, worktree, env, logFile, cgroupDir);
    const fail = async (phase: AppInstancePhase, error: unknown): Promise<never> => {
      await stopLaunched(launched, options.cgroups);
      const log = tail(await readFile(logFile, "utf8").catch(() => ""));
      throw new AppInstanceError(phase, `${error instanceof Error ? error.message : String(error)}${log ? `\n--- launch.log (tail) ---\n${log}` : ""}`);
    };
    let endpoints: Endpoints;
    try {
      endpoints = await resolveEndpoints(manifest, worktree, { describe: options.describe ?? describeAspire, deadline, intervalMs, launcherExited: launched.exit });
    } catch (error) { return await fail("endpoints", error); }
    try {
      await waitForReadiness(endpoints, manifest.readiness?.paths ?? {}, { probe: options.probe ?? httpProbe, deadline, intervalMs, launcherExited: launched.exit });
    } catch (error) { return await fail("readiness", error); }
    const readinessMs = Date.now() - started;
    let storageState: string | null = null;
    if (manifest.auth) {
      try {
        storageState = await establishAuth(manifest.auth, worktree, endpoints, dir, { cgroupDir, logFile: join(dir, "auth-setup.log"), timeoutMs: 300_000 });
      } catch (error) { return await fail("auth", error); }
    }
    await writeFile(join(dir, "instance.json"), JSON.stringify({ runId: options.runId, endpoints, storageState, launchedAt: new Date(started).toISOString(), readinessMs, fingerprint, cgroup: cgroupDir }, null, 2), { mode: 0o600 });
    await options.onStarted?.({ runId: options.runId, endpoints, storageState, readinessMs });
    return { launched, endpoints, storageState, readinessMs, fingerprint };
  };

  let current = await bringUp();
  const instance: AppInstance = {
    dir,
    runId: options.runId,
    get endpoints() { return current.endpoints; },
    get storageState() { return current.storageState; },
    get readinessMs() { return current.readinessMs; },
    get fingerprint() { return current.fingerprint; },
    environment() {
      const result: NodeJS.ProcessEnv = { PI_QA_INSTANCE: dir, PI_QA_RUN_ID: options.runId };
      for (const [key, url] of Object.entries(current.endpoints)) result[endpointEnvironmentName(key)] = url;
      if (current.storageState) result.PI_QA_STORAGE_STATE = current.storageState;
      return result;
    },
    async ensureCurrent() {
      if (await sourceFingerprint(worktree) === current.fingerprint) return false;
      await stopLaunched(current.launched, options.cgroups);
      current = await bringUp();
      return true;
    },
    async stop() {
      await stopLaunched(current.launched, options.cgroups);
    },
  };
  return instance;
}
```

If the file crosses 300 lines, move `launch`/`stopLaunched`/`tail`/`availableMb` into `src/app-instance/process.ts` and import them.

- [ ] **Step 5: Implement `src/app-instance/index.ts`**

```ts
import type { WorkerConfig } from "../config.js";
import type { CgroupController } from "../agent/cgroup.js";
import type { QaManifest } from "../qa-manifest.js";
import { startAppInstance, type AppInstance, type AppInstanceOptions } from "./instance.js";

export * from "./instance.js";
export type { Endpoints } from "./endpoints.js";

/** The worker-level service the flows inject; tests replace `start` with a fake. */
export class AppInstanceService {
  constructor(private readonly config: WorkerConfig, private readonly cgroups: CgroupController) {}
  start(worktree: string, manifest: QaManifest, options: Omit<AppInstanceOptions, "cgroups">): Promise<AppInstance> {
    return startAppInstance(this.config, worktree, manifest, { ...options, cgroups: this.cgroups });
  }
}
```

Patch the spec sentence (A.5): replace "the manifest loader rejects a path `git check-ignore` does not accept" with "the auth step rejects a path `git check-ignore` does not accept".

- [ ] **Step 6: Run** — `npx tsx --test test/app-instance.test.ts` — Expected: 7 pass. Then `npm run check`.

- [ ] **Step 7: Commit**

```bash
chmod +x test/fixtures/fake-launcher.sh
git add src/app-instance test/app-instance.test.ts test/fixtures/fake-launcher.sh docs/superpowers/specs/2026-09-14-pi-shared-app-instance-design.md
git commit -m "feat(pi): harness-owned app instance — launch once, resolve, wait, authenticate, stop

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 10: prompts describe the running instance; verifier accepts it

**Files:**
- Modify: `src/prompts/shared.ts` (`qaManifestInstructions`, `visualInstructions`), `src/prompts/implementation.ts` (`buildUiVerificationPrompt` option), `src/qa-verification.ts` (`verify` signature, prompt, run environment), `src/pi-agent.ts` (`environment` already added in Task 2)
- Test: `test/prompts.test.ts`, `test/qa-verification.test.ts`

**Interfaces:**
- Consumes: `AppInstanceSummary` (Task 9).
- Produces: `visualInstructions(config, evidenceDir, gif, manifest?, instance?: AppInstanceSummary | null)`; `buildUiVerificationPrompt({ …, instance?: AppInstanceSummary | null })`; `QaVerificationService.verify(issue, worktree, plan, options?: { instance?: AppInstance | null })`; new export `runningInstanceInstructions(instance: AppInstanceSummary): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/prompts.test.ts — add
test("a running instance replaces launch procedures with endpoints, storage state and prohibitions", () => {
  const cfg = config(tmpdir());
  const manifest = { version: 1 as const, launch: { argv: ["./run.sh"] }, readiness: { paths: { frontend: "/en" } }, auth: { storageState: "e2e/.auth/state.json" } };
  const instance = { endpoints: { frontend: "http://localhost:3005", api: "https://localhost:44431" }, storageState: "/data/instances/issue-1/r/storage-state.json", readinessMs: 82_000 };
  const text = buildUiVerificationPrompt({ config: cfg, issueNumber: 1, prNumber: null, evidenceDir: ".qa/issues/1/runs/x", qaManifest: manifest, instance });
  for (const rule of [
    /already running for this run/, /frontend `http:\/\/localhost:3005`/, /api `https:\/\/localhost:44431`/,
    /state-load \/data\/instances\/issue-1\/r\/storage-state\.json/, /Do not start, stop or relaunch/, /do not use `setsid`/,
    /Do not run the repository's Playwright e2e or post-deploy suites/,
  ]) assert.match(text, rule);
  for (const gone of [/Start the stack with exactly/, /ASPIRE_CLI_START_TIMEOUT/, /inspect every intended loopback port/, /the controller terminates every background process/]) assert.doesNotMatch(text, gone);
  assert.match(text, /playwright-cli open\/interact\/capture\/close sequence in one bash tool call/);
});

// test/qa-verification.test.ts — add (the file already fakes an agent; follow its pattern)
test("verify passes the instance to the agent's environment and prompt", async () => {
  // build root + worktree as the existing tests do
  let seen: { prompt: string; environment?: NodeJS.ProcessEnv } | null = null;
  const agent = { run: async (options: { prompt: string; environment?: NodeJS.ProcessEnv }) => { seen = options; return { sessionFile: null, finalText: "{}", verificationEvidence: undefined }; } };
  const service = new QaVerificationService(cfg, agent as never);
  const instance = { dir: "/i", runId: "r", fingerprint: "f", endpoints: { frontend: "http://localhost:3005" }, storageState: null, readinessMs: 1, environment: () => ({ PI_QA_INSTANCE: "/i", PI_QA_ENDPOINT_FRONTEND: "http://localhost:3005" }), ensureCurrent: async () => false, stop: async () => undefined };
  await service.verify(uiIssue, worktree, null, { instance }).catch(() => undefined);
  assert.equal(seen!.environment?.PI_QA_ENDPOINT_FRONTEND, "http://localhost:3005");
  assert.match(seen!.prompt, /already running for this run/);
});
```

- [ ] **Step 2: Run to verify they fail** — `npx tsx --test test/prompts.test.ts test/qa-verification.test.ts` — Expected: FAIL (unknown option `instance`).

- [ ] **Step 3: Implement**

In `src/prompts/shared.ts`:

```ts
import type { AppInstanceSummary } from "../app-instance/index.js";

export function runningInstanceInstructions(instance: AppInstanceSummary): string {
  const endpoints = Object.entries(instance.endpoints).map(([key, url]) => `${key} \`${url}\``).join(", ");
  return `The application is already running for this run (launched by the controller from the repository's QA manifest; ready after ${Math.round(instance.readinessMs / 1000)} s). Endpoints: ${endpoints}. The same values are in the environment as PI_QA_ENDPOINT_<NAME>.
${instance.storageState ? `- A Playwright storage state for the declared QA role is at \`${instance.storageState}\` (also $PI_QA_STORAGE_STATE): load it with \`playwright-cli -s=<session> state-load ${instance.storageState}\` before navigating instead of driving the login form.\n` : ""}- Do not start, stop or relaunch the stack, do not run the launcher, do not use \`setsid\`, \`nohup\` or \`disown\`; if the instance is unusable, report BLOCKED with the exact observation (URL, status, console/network evidence).
- Do not run the repository's Playwright e2e or post-deploy suites; check behaviour directly against this instance with playwright-cli.
`;
}
```

`qaManifestInstructions(manifest, instance)` returns the manifest JSON block followed by `runningInstanceInstructions(instance)` when `instance` is given, otherwise today's procedures. `visualInstructions(config, evidenceDir, gif, manifest, instance)`: when `instance` is given, omit the storage-state line ("Optional protected Playwright storage state"), the seeded-accounts paragraph, the "Before launching a server, inspect every intended loopback port" bullet, `stackInstructions`, the Aspire bullet, and `commandLifetimeInstructions`; emit instead `- Keep the complete playwright-cli open/interact/capture/close sequence in one bash tool call with a cleanup trap that closes the browser; the application is not yours to start or stop.\n`. The preflight bullet stays but reads "open the running instance's frontend endpoint and prove a small `preflight.png` can be captured".

`buildUiVerificationPrompt` gains `instance?: AppInstanceSummary | null` and forwards it; its opening sentence becomes "Verify the changed UI behavior on the running application (or launch the narrowest truthful preview when no instance is provided)".

In `src/qa-verification.ts`: `async verify(issue, worktree, plan, options: { instance?: AppInstance | null } = {})`; `runOptions` gains `environment: options.instance?.environment()`; the prompt passes `instance: options.instance ?? null` to `buildUiVerificationPrompt`, and the line "A backend or service that is merely not running…" is emitted only when there is no instance.

- [ ] **Step 4: Run** — `npx tsx --test test/prompts.test.ts test/qa-verification.test.ts test/verification.test.ts` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/shared.ts src/prompts/implementation.ts src/qa-verification.ts test/prompts.test.ts test/qa-verification.test.ts
git commit -m "feat(pi): prompts describe the running instance; the verifier takes it

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 11: stage wrapper and worker wiring

**Files:**
- Create: `src/worker/app-stage.ts`
- Modify: `src/worker/shared.ts` (`WorkerContext.appInstances`), `src/worker.ts` (DI), `src/worker/verification-flow.ts` (`instance` parameter), `src/worker/evidence-flow.ts` (`runUiVerification` takes `instance`), `test/helpers/worker-fixtures.ts`
- Test: `test/worker-app-stage.test.ts`

**Interfaces:**
- Consumes: `AppInstanceService`, `AppInstance` (Task 9), `worktreeUiSurface` (Task 6).
- Produces:
  ```ts
  export async function withAppInstance<T>(ctx: WorkerContext, worktree: string, job: { issueNumber: number }, needsInstance: boolean, fn: (instance: AppInstance | null) => Promise<T>): Promise<T>;
  export async function stageNeedsInstance(ctx: WorkerContext, issue: GitHubIssue, worktree: string, visual: boolean): Promise<boolean>; // visual || worktreeUiSurface(...)
  // verification-flow: verifyImplementation(ctx, job, worktree, issue?, instance?: AppInstance | null)
  // evidence-flow: runUiVerification(ctx, job, worktree, prNumber, instance?: AppInstance | null)
  // WorkerContext.appInstances: Pick<AppInstanceService, "start">
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/worker-app-stage.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withAppInstance } from "../src/worker/app-stage.js";
import { config } from "./helpers/worker-fixtures.js";

function fakeInstance(log: string[]) {
  return { dir: "/i", runId: "r", fingerprint: "f", endpoints: { frontend: "http://localhost:3005" }, storageState: null, readinessMs: 1,
    environment: () => ({}), ensureCurrent: async () => { log.push("ensure"); return false; }, stop: async () => { log.push("stop"); } };
}

async function worktreeWithLaunch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-stage-"));
  await mkdir(join(root, "w", ".pi-worker"), { recursive: true });
  await writeFile(join(root, "w", ".pi-worker", "qa.json"), JSON.stringify({ version: 1, launch: { argv: ["./run.sh"] }, readiness: { endpoints: { frontend: "http://localhost:3005" } } }));
  return root;
}

test("withAppInstance starts once, hands the instance to the stages and stops in finally", async () => {
  const root = await worktreeWithLaunch();
  const log: string[] = [];
  const ctx = { config: config(root), appInstances: { start: async () => { log.push("start"); return fakeInstance(log); } } };
  const result = await withAppInstance(ctx as never, join(root, "w"), { issueNumber: 1 }, true, async (instance) => { log.push(`stage:${instance?.endpoints.frontend}`); return 7; });
  assert.equal(result, 7);
  assert.deepEqual(log, ["start", "stage:http://localhost:3005", "stop"]);
  await assert.rejects(withAppInstance(ctx as never, join(root, "w"), { issueNumber: 1 }, true, async () => { throw new Error("stage failed"); }), /stage failed/);
  assert.equal(log.filter((entry) => entry === "stop").length, 2);
  await rm(root, { recursive: true, force: true });
});

test("no manifest launch or no need means no instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stage-"));
  await mkdir(join(root, "w"));
  let starts = 0;
  const ctx = { config: config(root), appInstances: { start: async () => { starts += 1; throw new Error("unexpected"); } } };
  assert.equal(await withAppInstance(ctx as never, join(root, "w"), { issueNumber: 1 }, true, async (instance) => instance), null);
  const withLaunch = await worktreeWithLaunch();
  assert.equal(await withAppInstance({ ...ctx, config: config(withLaunch) } as never, join(withLaunch, "w"), { issueNumber: 1 }, false, async (instance) => instance), null);
  assert.equal(starts, 0);
  await rm(root, { recursive: true, force: true });
  await rm(withLaunch, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/worker-app-stage.test.ts` — Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// src/worker/app-stage.ts
import { randomUUID } from "node:crypto";
import type { AppInstance } from "../app-instance/index.js";
import { loadQaManifest } from "../qa-manifest.js";
import type { GitHubIssue } from "../types.js";
import { worktreeUiSurface } from "../ui-surface.js";
import type { WorkerContext } from "./shared.js";

/** Whether the browser stages of this run need the application: visual evidence was requested, or the surface is UI. */
export async function stageNeedsInstance(ctx: WorkerContext, issue: GitHubIssue, worktree: string, visual: boolean): Promise<boolean> {
  return visual || await worktreeUiSurface(issue, worktree, ctx.config.baseBranch);
}

/**
 * One app instance for every browser stage of a job run. Launched from the manifest's `launch` before
 * the first stage, stopped after the last in `finally`; without `launch`, or when no stage needs the
 * app, the stages get `null` and behave exactly as before this existed.
 */
export async function withAppInstance<T>(
  ctx: WorkerContext,
  worktree: string,
  job: { issueNumber: number },
  needsInstance: boolean,
  fn: (instance: AppInstance | null) => Promise<T>,
): Promise<T> {
  const manifest = await loadQaManifest(worktree, ctx.config.qaManifestPath);
  if (!needsInstance || !manifest?.launch) return await fn(null);
  const instance = await ctx.appInstances.start(worktree, manifest, { issueNumber: job.issueNumber, runId: randomUUID() });
  try {
    return await fn(instance);
  } finally {
    await instance.stop().catch(() => undefined);
  }
}
```

`WorkerContext` gains `readonly appInstances: Pick<AppInstanceService, "start">`. `IssueWorker` constructor accepts `appInstances?: Pick<AppInstanceService, "start">` and defaults to `new AppInstanceService(config, cgroupController(ownCgroupPath()))`; it also passes the same controller to `new PiAgentRunner(config, { cgroups })` so bash calls and instances share the root. `TestIssueWorker` in `test/helpers/worker-fixtures.ts` defaults `appInstances: { start: async () => { throw new Error("no app instance in controller-flow tests"); } }` — flows must only call it when a manifest declares `launch`.

`verifyImplementation(ctx, job, worktree, issue?, instance = null)` → `ctx.qaVerifier.verify(original, worktree, plan, { instance })`; `runUiVerification(ctx, job, worktree, prNumber, instance = null)` → `await instance?.ensureCurrent()` first, passes `instance` to `buildUiVerificationPrompt` and `environment: instance?.environment()` to `ctx.agent.run`.

- [ ] **Step 4: Run** — `npx tsx --test test/worker-app-stage.test.ts` then `npm run check` — Expected: green (existing flow tests unchanged: no manifest in their worktrees).

- [ ] **Step 5: Commit**

```bash
git add src/worker/app-stage.ts src/worker/shared.ts src/worker.ts src/worker/verification-flow.ts src/worker/evidence-flow.ts test/helpers/worker-fixtures.ts test/worker-app-stage.test.ts
git commit -m "feat(pi): stage wrapper — one app instance for every browser stage of a run

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 12: issue and feedback flows share the instance

**Files:**
- Modify: `src/worker/issue-flow.ts:130-214`, `src/worker/feedback-flow.ts:150-190`
- Test: `test/worker-issue-instance.test.ts` (new; copy the fixture style of `test/worker-conflict.test.ts`)

**Interfaces:**
- Consumes: `withAppInstance`, `stageNeedsInstance` (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
test("with a manifest launch the implementer does not capture during implementation; visual QA and the verifier share one instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-issue-instance-"));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".pi-worker"), { recursive: true });
  await writeFile(join(worktree, ".pi-worker", "qa.json"), JSON.stringify({ version: 1, launch: { argv: ["./run.sh"] }, readiness: { endpoints: { frontend: "http://localhost:3005" } } }));
  const state = new WorkerState(join(root, "state.sqlite"));
  const uiIssue = { ...issue, labels: [{ name: "pi-ready" }, { name: "pi-visual" }] };
  const log: string[] = [];
  const prompts: string[] = [];
  const instance = { dir: "/i", runId: "r", fingerprint: "f", endpoints: { frontend: "http://localhost:3005" }, storageState: null, readinessMs: 1,
    environment: () => ({ PI_QA_INSTANCE: "/i" }), ensureCurrent: async () => false, stop: async () => { log.push("stop"); } };
  const github = { getIssue: async () => uiIssue, listReadyIssues: async () => [uiIssue], claimIssue: async () => undefined, markInProgress: async () => undefined,
    createPullRequest: async () => ({ number: 9, url: "https://github.com/example/widgets/pull/9" }), markPullRequestOpen: async () => undefined, commentIssue: async () => undefined,
    commentPullRequest: async () => undefined, listFeedback: async () => [], isPullRequestOpen: async () => true, getPullRequestChecks: async () => ({ headSha: "h", state: "pending", failures: [] }),
    getPullRequestMergeState: async () => ({ headSha: "h", baseSha: "b", baseBranch: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }) };
  const repository = { ensureIssueWorktree: async () => ({ branch: "pi/issue-42", path: worktree }), changedFiles: async () => ["frontend/app/page.tsx"], hasCommitsAhead: async () => false,
    commitAndPush: async () => "h", headRevision: async () => "h", clearAgentChanges: async () => undefined, filesAheadOfBase: async () => ["frontend/app/page.tsx"] };
  const agent = { run: async (options: { prompt: string; visualVerification?: boolean; environment?: NodeJS.ProcessEnv }) => {
    prompts.push(options.prompt); log.push(options.visualVerification ? `visual:${options.environment?.PI_QA_INSTANCE}` : "implement");
    return { sessionFile: join(root, "s.jsonl"), finalText: "Done." }; } };
  const qaVerifier = { verify: async (_i: unknown, _w: string, _p: unknown, options?: { instance?: unknown }) => { log.push(`verify:${options?.instance ? "instance" : "none"}`); return "/r.json"; } };
  const worker = new IssueWorker(config(root), state, { github: github as never, repository: repository as never, agent: agent as never, qaVerifier, appInstances: { start: async () => { log.push("start"); return instance; } } });
  await worker.tick();
  assert.deepEqual(log, ["implement", "start", "visual:/i", "verify:instance", "stop"]);
  assert.doesNotMatch(prompts[0], /Visual verification is requested/);
  assert.match(prompts[1], /already running for this run/);
  await rm(root, { recursive: true, force: true });
});
```

Adjust the fake `github`/`repository` members to whatever `issue-flow.ts` actually calls (read it; the test must construct exactly the methods the flow touches, as `test/worker-conflict.test.ts` does).

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test test/worker-issue-instance.test.ts` — Expected: FAIL (implementer prompt still requests visual capture; `appInstances` unused).

- [ ] **Step 3: Implement** — in `issue-flow.ts`:

```ts
const manifest = await loadQaManifest(worktree.path, ctx.config.qaManifestPath);
const harnessLaunches = Boolean(manifest?.launch);
// implementer main run: evidenceDir is null when the harness launches — capture moves to the visual stage
if (visual && !harnessLaunches) evidence = await createTrackedEvidence(ctx, worktree.path, issue.number, null);
// … agent.run({ …, evidenceDir: evidence?.relativeRunDir ?? null, visualVerification: evidence !== null }) unchanged …
```

then replace the post-run block (`if (!evidence && containsUiFiles(...)) { evidence = await runUiVerification(...) }` … `finalText += await verifyImplementation(...)`) with:

```ts
const needsInstance = await stageNeedsInstance(ctx, issue, worktree.path, visual);
finalText += await withAppInstance(ctx, worktree.path, job, needsInstance, async (instance) => {
  if (!evidence && (visual || containsUiFiles(await ctx.repository.changedFiles(worktree.path)))) {
    evidence = await runUiVerification(ctx, job, worktree.path, null, instance);
  }
  if (evidence) await finalizeEvidence(ctx, evidence);   // keep the existing try/catch + clearAgentChanges around it
  return await verifyImplementation(ctx, job, worktree.path, issue, instance);
});
```

Do the same in the recovered branch (`else { … recoveredUi … }`) and in `feedback-flow.ts` around lines 180–184. Keep the file under 300 lines: if `issue-flow.ts` crosses it, move the implementer-run block (`ctx.agent.run` + its two catch/blocked branches) into `src/worker/issue-implement.ts` as `runImplementer(ctx, job, issue, worktree, evidence, manifest)`.

- [ ] **Step 4: Run** — `npx tsx --test test/worker-issue-instance.test.ts` and `npm run check` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/worker/issue-flow.ts src/worker/feedback-flow.ts src/worker/issue-implement.ts test/worker-issue-instance.test.ts
git commit -m "feat(pi): issue and feedback flows run visual QA and the verifier against one shared instance

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 13: push-first conflict resolution with verifier evidence

**Files:**
- Modify: `src/worker/conflict-flow.ts:125-274` (both paths), `src/worker/evidence-flow.ts` (`publishEvidenceDirectory`)
- Test: `test/worker-conflict.test.ts` (re-order assertions), `test/worker-conflict-recovery.test.ts`, `test/worker-conflict-postpush.test.ts` (new)

**Interfaces:**
- Produces: `publishEvidenceDirectory(ctx, prNumber, worktree, directory: string, runId: string): Promise<{ note: string; eventKey: string } | null>`; conflict comments `🔀 Base-branch conflicts resolved and pushed. Verification follows.`, `✅ Post-resolution verification passed.`, `⚠️ Post-resolution verification failed — the resolution stays pushed; CI is the other check.`

- [ ] **Step 1: Write the failing tests**

```ts
// test/worker-conflict-postpush.test.ts — same fixture shape as test/worker-conflict.test.ts
test("a resolution is pushed before verification; a failed verification is reported, not reverted", async () => {
  // … state/github/repository/agent as in the sibling test, plus:
  const order: string[] = [];
  const repository = { /* … */ stageBaseMerge: async () => { order.push("stage"); }, finishBaseMerge: async () => { order.push("push"); }, abortBaseMerge: async () => { order.push("abort"); }, clearAgentChanges: async () => { order.push("discard"); }, headRevision: async () => "new-head" };
  const qaVerifier = { verify: async () => { order.push("verify"); throw new Error("Independent QA gate: Independent QA FAILED: colours off. Local report: /v/issue-42/r/result.json"); } };
  // … worker.tick() twice …
  assert.deepEqual(order, ["stage", "push", "verify"]);
  assert.ok(comments.some((c) => /🔀 Base-branch conflicts resolved and pushed\. Verification follows\./.test(c)));
  assert.ok(comments.some((c) => /⚠️ Post-resolution verification failed — the resolution stays pushed; CI is the other check\./.test(c) && /colours off/.test(c)));
  assert.ok(!comments.some((c) => /⛔/.test(c)));
  assert.equal(state.get(42)?.status, "pr_open");
  assert.match(state.get(42)?.lastError ?? "", /colours off/);
});

test("a resolution that fails before the push is aborted and discarded as before", async () => {
  // agent returns "BLOCKED: cannot resolve"; expect order ["abort", "discard"], a ⛔ comment, and no push
});

test("a passed post-resolution verification publishes the verifier's evidence directory", async () => {
  // qaVerifier.verify resolves "/v/issue-42/r/result.json" after writing /v/issue-42/r/evidence/desktop.png + mobile.png (valid PNG headers)
  // github.publishEvidence records (prNumber, headSha, runId, attachments) → assert runId === "r", two attachments, and a "✅ Post-resolution verification passed" comment
});
```

Write the three tests in full following `test/worker-conflict.test.ts` (copy its `github`/`repository`/`agent` objects; the file must stay ≤ 300 lines — the new file holds these three).

In `test/worker-conflict.test.ts`, the existing assertion that the verifier ran *before* `finishBaseMerge` (if any) flips to *after*; the "resolution verified then pushed" comment text updates to the new `🔀` wording.

- [ ] **Step 2: Run to verify they fail** — `npx tsx --test test/worker-conflict-postpush.test.ts` — Expected: FAIL on order (`verify` before `push`).

- [ ] **Step 3: Implement**

`publishEvidenceDirectory` in `evidence-flow.ts`:

```ts
export async function publishEvidenceDirectory(ctx: WorkerContext, prNumber: number, worktree: string, directory: string, runId: string): Promise<{ note: string; eventKey: string } | null> {
  if (typeof ctx.github.publishEvidence !== "function") return null;
  const { attachments, omitted } = await finalAttachments(directory);
  if (attachments.length === 0) return null;
  const eventKey = `evidence:${prNumber}:${runId}`;
  const note = await ctx.github.publishEvidence(prNumber, await ctx.repository.headRevision(worktree), runId, attachments);
  return note ? { note: `${note}${omissionNote(omitted)}`, eventKey } : null;
}
```

`conflict-flow.ts`, fresh path, after `stageBaseMerge`:

```ts
await assertPullRequestMergeContext(ctx, job.prNumber!, pullRequestHead, merge.baseSha);
await ctx.repository.finishBaseMerge(worktree.path, worktree.branch, job.issueNumber, pullRequestHead);
await ctx.github.markPullRequestOpen(job.issueNumber);
await ctx.github.commentPullRequest(job.prNumber!, `🔀 Base-branch conflicts resolved and pushed. Verification follows.\n\n${markdownSummary(result.finalText)}`);
ctx.state.completeEvent(job.issueNumber, eventKey, "pr_open");
await verifyAfterPush(ctx, job, worktree, issue);
```

with, in a new `src/worker/conflict-verify.ts` (keeps `conflict-flow.ts` under 300 lines):

```ts
export async function verifyAfterPush(ctx: WorkerContext, job: IssueJob, worktree: { path: string }, issue: GitHubIssue): Promise<void> {
  try {
    const needsInstance = await stageNeedsInstance(ctx, issue, worktree.path, job.visualRequested);
    const summary = await withAppInstance(ctx, worktree.path, job, needsInstance, (instance) => verifyImplementation(ctx, job, worktree.path, issue, instance));
    const report = /Local report: `([^`]+)`/.exec(summary)?.[1];
    const published = report ? await publishEvidenceDirectory(ctx, job.prNumber!, worktree.path, join(dirname(report), "evidence"), basename(dirname(report))).catch(() => null) : null;
    await ctx.github.commentPullRequest(job.prNumber!, `✅ Post-resolution verification passed.${summary}${published ? `\n\n${evidenceCommentMarker(published.eventKey)}\nConflict-resolution QA evidence (independent verifier).${published.note}` : ""}`);
    if (published) ctx.state.markProcessed(job.issueNumber, published.eventKey);
    ctx.state.setStatus(job.issueNumber, "pr_open");
  } catch (error) {
    if (isInterruptedRun(error)) throw error;
    await ctx.github.commentPullRequest(job.prNumber!, `⚠️ Post-resolution verification failed — the resolution stays pushed; CI is the other check.\n\n${markdownSummary(errorText(error))}`);
    ctx.state.setStatus(job.issueNumber, "pr_open", errorText(error));
  }
}
```

The existing `catch` in `handleMergeConflict` keeps its three branches (retryable → keep staged merge; local head moved → keep; otherwise abort + discard + ⛔); since the push now precedes verification, a failure after the push never reaches that catch. Apply the same reorder to the resumed-merge path (lines 125–180): stage → context → finish → comment → `verifyAfterPush`. Remove `runUiVerification` and `containsUiFiles`/`filesChangedBetween` from the conflict flow.

- [ ] **Step 4: Run** — `npx tsx --test test/worker-conflict.test.ts test/worker-conflict-recovery.test.ts test/worker-conflict-postpush.test.ts` then `npm run check` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/worker/conflict-flow.ts src/worker/conflict-verify.ts src/worker/evidence-flow.ts test/worker-conflict.test.ts test/worker-conflict-recovery.test.ts test/worker-conflict-postpush.test.ts
git commit -m "feat(pi): push a conflict resolution first; verify on the shared instance; publish the verifier's evidence

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 14: project memory

**Files:**
- Create: `src/project-memory.ts`
- Modify: `src/prompts/shared.ts` (`memoryInstructions`), `src/prompts/implementation.ts` (`buildIssuePrompt`, `buildFeedbackPrompt`, `buildUiVerificationPrompt` take `memory?`), `src/qa-verification.ts` (prompt), `src/worker/issue-flow.ts`, `src/worker/feedback-flow.ts`, `src/worker/evidence-flow.ts`, `src/worker/app-stage.ts` (`onStarted` writes `instance-timing.md`)
- Test: `test/project-memory.test.ts`, `test/prompts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MEMORY_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/; export const MEMORY_FILE_BYTES = 4096; export const MEMORY_FILES = 40; export const MEMORY_INDEX_BYTES = 6144;
  export function memoryDirectory(config: Pick<WorkerConfig, "dataDir">): string;               // <dataDir>/memory
  export function looksLikeSecret(text: string): boolean;
  export interface MemoryIndex { dir: string; text: string; skipped: string[] }
  export async function projectMemoryIndex(dir: string): Promise<MemoryIndex>;
  export async function writeMemoryNote(dir: string, slug: string, title: string, body: string): Promise<void>;
  // prompts/shared.ts
  export function memoryInstructions(memory: MemoryIndex | null | undefined): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/project-memory.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { looksLikeSecret, projectMemoryIndex, writeMemoryNote } from "../src/project-memory.js";

test("the index lists valid notes newest first with title and two body lines, capped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  await writeFile(join(dir, "launcher-timing.md"), "# Launcher takes ~80 s warm\nAspire reports Running after 18 s.\nFrontend answers after ~60 s more.\nignored third line\n");
  await utimes(join(dir, "launcher-timing.md"), new Date("2026-09-01"), new Date("2026-09-01"));
  await writeFile(join(dir, "flaky-moderation-test.md"), "# moderation-lifecycle spec is flaky under load\nRetry once before calling it a failure.\n");
  await writeFile(join(dir, "Bad Name.md"), "# nope\n");
  await writeFile(join(dir, "leak.md"), "# token\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
  await writeFile(join(dir, "huge.md"), `# big\n${"x".repeat(5000)}\n`);
  const index = await projectMemoryIndex(dir);
  assert.match(index.text, /^- flaky-moderation-test\.md — moderation-lifecycle spec is flaky under load\n  Retry once/m);
  assert.ok(index.text.indexOf("flaky-moderation-test.md") < index.text.indexOf("launcher-timing.md"));
  assert.doesNotMatch(index.text, /ignored third line|ghp_|nope|big/);
  assert.deepEqual(index.skipped.sort(), ["Bad Name.md", "huge.md", "leak.md"]);
  await rm(dir, { recursive: true, force: true });
});

test("the index stays within 6144 bytes and 40 files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  for (let i = 0; i < 60; i += 1) await writeFile(join(dir, `note-${String(i).padStart(2, "0")}.md`), `# note ${i}\n${"y".repeat(300)}\n`);
  const index = await projectMemoryIndex(dir);
  assert.ok(Buffer.byteLength(index.text) <= 6144);
  assert.ok((index.text.match(/^- note-/gm) ?? []).length <= 40);
  await rm(dir, { recursive: true, force: true });
});

test("looksLikeSecret catches tokens, bearer headers, passwords, cookies and private keys", () => {
  for (const text of ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Authorization: Bearer eyJ", "password=1q2w3E*", "cookie: .AspNetCore.Identity=abc", "-----BEGIN RSA PRIVATE KEY-----"]) assert.equal(looksLikeSecret(text), true, text);
  assert.equal(looksLikeSecret("The seeded admin account is used by e2e; see the repository's seed data."), false);
});

test("writeMemoryNote creates the directory and a titled note", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "pi-memory-")), "memory");
  await writeMemoryNote(dir, "instance-timing", "Instance timing", "readiness 82 s, auth 9 s");
  assert.equal(await readFile(join(dir, "instance-timing.md"), "utf8"), "# Instance timing\nreadiness 82 s, auth 9 s\n");
});
```

```ts
// test/prompts.test.ts — add
test("prompts render the project memory index and the saving rules", () => {
  const memory = { dir: "/data/memory", text: "- launcher-timing.md — Launcher takes ~80 s warm\n  Aspire reports Running after 18 s.\n", skipped: [] };
  const text = buildIssuePrompt({ config: config(tmpdir()), issue, evidenceDir: null, memory });
  assert.match(text, /Project memory — notes from earlier runs; advisory, verify before relying on them/);
  assert.match(text, /\/data\/memory/);
  assert.match(text, /launcher-timing\.md — Launcher takes ~80 s warm/);
  assert.match(text, /one durable fact per file/);
  assert.match(text, /never secrets/i);
});
```

- [ ] **Step 2: Run to verify they fail** — `npx tsx --test test/project-memory.test.ts test/prompts.test.ts` — Expected: module not found / unknown option.

- [ ] **Step 3: Implement `src/project-memory.ts`**

```ts
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "./config.js";

export const MEMORY_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
export const MEMORY_FILE_BYTES = 4096;
export const MEMORY_FILES = 40;
export const MEMORY_INDEX_BYTES = 6144;

const SECRET = /gh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+\S+|password\s*[:=]|\bcookie:|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/i;

export function memoryDirectory(config: Pick<WorkerConfig, "dataDir">): string {
  return join(config.dataDir, "memory");
}

export function looksLikeSecret(text: string): boolean {
  return SECRET.test(text);
}

export interface MemoryIndex { dir: string; text: string; skipped: string[] }

/** Title + first two body lines of every valid note, newest first, within the byte and file caps. */
export async function projectMemoryIndex(dir: string): Promise<MemoryIndex> {
  const skipped: string[] = [];
  const notes: Array<{ name: string; mtime: number; title: string; lines: string[] }> = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!MEMORY_FILE.test(name)) { skipped.push(name); continue; }
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > MEMORY_FILE_BYTES) { skipped.push(name); continue; }
    const content = await readFile(path, "utf8");
    if (looksLikeSecret(content)) { skipped.push(name); continue; }
    const [first = "", ...rest] = content.split("\n");
    const title = first.replace(/^#\s*/, "").trim() || name;
    notes.push({ name, mtime: info.mtimeMs, title, lines: rest.filter((line) => line.trim()).slice(0, 2) });
  }
  notes.sort((a, b) => b.mtime - a.mtime);
  let text = "";
  for (const note of notes.slice(0, MEMORY_FILES)) {
    const entry = `- ${note.name} — ${note.title}\n${note.lines.map((line) => `  ${line}`).join("\n")}${note.lines.length ? "\n" : ""}`;
    if (Buffer.byteLength(text + entry) > MEMORY_INDEX_BYTES) break;
    text += entry;
  }
  return { dir, text, skipped };
}

export async function writeMemoryNote(dir: string, slug: string, title: string, body: string): Promise<void> {
  if (!MEMORY_FILE.test(`${slug}.md`)) throw new Error(`invalid memory note name: ${slug}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${slug}.md`), `# ${title}\n${body.trim()}\n`, { mode: 0o600 });
}
```

`src/prompts/shared.ts`:

```ts
export function memoryInstructions(memory: MemoryIndex | null | undefined): string {
  if (!memory) return "";
  return `
Project memory — notes from earlier runs; advisory, verify before relying on them. Directory: ${memory.dir}
${memory.text || "(empty)"}
Read a note's file before acting on it. At the end of your run save new durable findings there — one durable fact per file named like \`launcher-timing.md\`, first line \`# title\`, under 4 KB: environment and repository facts (launcher timing, port conventions, seeded roles, flaky tests and why, checks that fail on the base branch, what a previous attempt got wrong). Update an existing file instead of duplicating it. Never issue-specific transient state, never secrets (tokens, passwords, cookies, keys).
`;
}
```

Prompt builders (`buildIssuePrompt`, `buildFeedbackPrompt`, `buildUiVerificationPrompt`) take `memory?: MemoryIndex | null` and append `memoryInstructions(options.memory)`; the verifier prompt appends it too. Flows load it once per run: `const memory = await projectMemoryIndex(memoryDirectory(ctx.config));` (issue-flow, feedback-flow, `runUiVerification`, `QaVerificationService.verify`). In `app-stage.ts`, `start(...)` gets `onStarted: async (summary) => writeMemoryNote(memoryDirectory(ctx.config), "instance-timing", "App instance timing (harness-written)", \`Last launch ready after ${Math.round(summary.readinessMs / 1000)} s (run ${summary.runId}); auth ${summary.storageState ? "set up" : "not declared"}.\`)`.

- [ ] **Step 4: Run** — `npx tsx --test test/project-memory.test.ts test/prompts.test.ts` then `npm run check` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/project-memory.ts src/prompts/shared.ts src/prompts/implementation.ts src/qa-verification.ts src/worker/issue-flow.ts src/worker/feedback-flow.ts src/worker/evidence-flow.ts src/worker/app-stage.ts test/project-memory.test.ts test/prompts.test.ts
git commit -m "feat(pi): project memory — per-repository notes shared across runs

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

---

### Task 15: documentation, deploy, live run

**Files:**
- Modify: `README.md` (manifest section: `launch`/`readiness.endpoints`/`auth` are executed by the harness; "App instance" section; "Project memory" section; conflict flow description), `docs/troubleshooting.md` (symptoms: `App instance memory failed`, `App instance readiness failed`, `auth.storageState must be gitignored`; how to read `<dataDir>/instances/…/launch.log`; `Delegate=yes` requirement), `.env.example` (done in Task 4)

- [ ] **Step 1: Write the docs** — README gains, under the manifest section:

```markdown
### What the worker does with `launch`, `readiness` and `auth`

With `launch` declared, the worker — not the agent — brings the application up once per job run:
it runs `launch.argv` in the worktree inside a child cgroup, resolves `aspire.resources` through
`aspire describe` (or takes `readiness.endpoints` as given), waits until every `readiness.paths`
probe answers, runs `auth.setup` and copies `auth.storageState` out of the worktree, then hands the
agents `PI_QA_ENDPOINT_<NAME>`, `PI_QA_STORAGE_STATE` and `PI_QA_INSTANCE`. The visual stage and the
independent verifier share that instance; it is relaunched if the tree changes between stages and
stopped (SIGTERM, then `cgroup.kill`) when the run ends. Launch logs live under
`<data-dir>/instances/issue-<n>/<run>/`. Limits: `PI_WORKER_APP_START_TIMEOUT` (900 s),
`PI_WORKER_APP_MIN_AVAILABLE_MB` (4096).
```

and a "Project memory" section describing `<data-dir>/memory/`, the file rules, the index cap, the secret filter, and that notes are advisory. Troubleshooting gains the three symptom rows and a section "App instance failed" with `cat <data-dir>/instances/issue-<n>/<run>/launch.log`.

- [ ] **Step 2: Gate** — `npm run check` — Expected: green; note the new test count in the commit message.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/troubleshooting.md
git commit -m "docs(pi): app instance lifecycle, push-first conflicts, project memory

Claude-Session: https://claude.ai/code/session_01DphUtDUGMKTvXz8wHe5zmu"
```

- [ ] **Step 4: Deploy and run live** — with the owner's go: `./scripts/setup-pi-issue-worker.sh && systemctl --user daemon-reload && systemctl --user restart pi-issue-worker-supervisor.service` (profiles idle first: `systemctl --user status pi-issue-worker-supervisor.service`). Merge `iiasa/IIASA.GeoWiki#580` so the manifest is on `dev`, post `/pi retry` on PR 501, watch `<data-dir>/instances/issue-501/*/launch.log` and `memory/instance-timing.md`; record the phase timings in the PR #19 description.

---

## Self-review

**Spec coverage.** A (start/expose/stale/stop/stage wrapper): Tasks 7–11. B (cgroup, shim, Delegate, MSBuild flags, sweep): Tasks 1–3. C (conflict flow drops the implementer pass, verifier evidence published, verifier told no e2e, issue/feedback share the instance, implementer no longer captures): Tasks 10, 12, 13. D (push-first): Task 13. E (memory, index, secret filter, harness entries, trust wording): Task 14. Configuration: Task 4. Manifest `readiness.endpoints`: Task 5. UI heuristic shared: Task 6. Docs and live run: Task 15.

**Placeholders.** Task 12's fake `github`/`repository` objects are explicitly to be completed against `issue-flow.ts`'s real call list — that is a reading instruction, not a gap; the test body is given. Task 13's second and third tests are described rather than written out to keep the plan under control; they follow the first test's fixture exactly and the assertions are stated. Task 9 notes the `process.ts` split as conditional on the 300-line cap.

**Type consistency.** `CgroupController` (Task 1) is what Tasks 2, 3, 9, 11 consume; `AppInstance`/`AppInstanceSummary`/`AppInstanceService` (Task 9) are what Tasks 10–14 consume; `Endpoints` flows from Task 7 through 8, 9, 10; `MemoryIndex` (Task 14) is the prompt option type; `verifyImplementation(ctx, job, worktree, issue?, instance?)` and `runUiVerification(ctx, job, worktree, prNumber, instance?)` are used with those arities in Tasks 12 and 13; `withAppInstance` and `stageNeedsInstance` keep the Task 11 signatures in 12 and 13.
