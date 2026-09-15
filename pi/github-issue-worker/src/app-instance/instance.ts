import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CgroupController } from "../agent/cgroup.js";
import { sandboxEnvironment } from "../agent/sandbox.js";
import type { WorkerConfig } from "../config.js";
import { sourceFingerprint } from "../figma-verification.js";
import type { QaManifest } from "../qa-manifest.js";
import { establishAuth } from "./auth.js";
import { describeAspire, resolveEndpoints, type DescribeAspire, type Endpoints } from "./endpoints.js";
import { availableMb, launch, stopLaunched, tail, type Launched } from "./process.js";
import { httpProbe, waitForReadiness, type Probe } from "./readiness.js";

export type AppInstancePhase = "memory" | "launch" | "endpoints" | "readiness" | "auth";

export class AppInstanceError extends Error {
  constructor(readonly phase: AppInstancePhase, message: string) {
    super(`App instance ${phase} failed: ${message}`);
  }
}

/** What prompts and the memory note need to know about a running instance. */
export interface AppInstanceSummary {
  endpoints: Endpoints;
  storageState: string | null;
  readinessMs: number;
}

/**
 * One application launched from the repository's QA manifest, shared by every browser stage of a job
 * run. It is bound to the source fingerprint at launch; `ensureCurrent` relaunches when the tree moved.
 */
export interface AppInstance extends AppInstanceSummary {
  readonly dir: string;
  readonly runId: string;
  readonly fingerprint: string;
  /** `PI_QA_INSTANCE`, `PI_QA_RUN_ID`, `PI_QA_ENDPOINT_<KEY>` and, with auth, `PI_QA_STORAGE_STATE`. */
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
  /** Test-only: extra variables for the launcher (the flows never pass this). */
  launchEnvironment?: NodeJS.ProcessEnv;
  onStarted?: (summary: AppInstanceSummary & { runId: string }) => Promise<void>;
}

export function endpointEnvironmentName(key: string): string {
  return `PI_QA_ENDPOINT_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

interface Running extends AppInstanceSummary {
  launched: Launched;
  fingerprint: string;
}

export async function startAppInstance(
  config: WorkerConfig,
  worktree: string,
  manifest: QaManifest,
  options: AppInstanceOptions,
): Promise<AppInstance> {
  const launchSpec = manifest.launch;
  if (!launchSpec) throw new AppInstanceError("launch", "the QA manifest declares no launch");
  const dir = join(config.dataDir, "instances", `issue-${options.issueNumber}`, options.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const logFile = join(dir, "launch.log");
  const intervalMs = options.intervalMs ?? 3_000;
  const available = await availableMb(options.meminfoPath ?? "/proc/meminfo");
  if (available !== null && available < config.appMinAvailableMb) {
    throw new AppInstanceError("memory", `${available} MB available, ${config.appMinAvailableMb} MB required`);
  }
  const env: NodeJS.ProcessEnv = {
    ...sandboxEnvironment(),
    ...(launchSpec.env ?? {}),
    ...(options.launchEnvironment ?? {}),
    PI_QA_RUN_ID: options.runId,
  };

  const bringUp = async (): Promise<Running> => {
    const started = Date.now();
    const deadline = started + config.appStartTimeoutSeconds * 1_000;
    const fingerprint = await sourceFingerprint(worktree);
    const cgroupDir = await options.cgroups.createChild(`qa-${options.runId}`);
    const launched = launch(launchSpec.argv, worktree, env, logFile, cgroupDir);
    const fail = async (phase: AppInstancePhase, error: unknown): Promise<never> => {
      await stopLaunched(launched, options.cgroups, 5_000);
      const log = tail(await readFile(logFile, "utf8").catch(() => ""));
      const message = error instanceof Error ? error.message : String(error);
      throw new AppInstanceError(phase, `${message}${log ? `\n--- launch.log (tail) ---\n${log}` : ""}`);
    };
    let endpoints: Endpoints;
    try {
      endpoints = await resolveEndpoints(manifest, worktree, {
        describe: options.describe ?? describeAspire, deadline, intervalMs, launcherExited: launched.exit,
      });
    } catch (error) {
      return await fail("endpoints", error);
    }
    try {
      await waitForReadiness(endpoints, manifest.readiness?.paths ?? {}, {
        probe: options.probe ?? httpProbe, deadline, intervalMs, launcherExited: launched.exit,
      });
    } catch (error) {
      return await fail("readiness", error);
    }
    const readinessMs = Date.now() - started;
    let storageState: string | null = null;
    if (manifest.auth) {
      try {
        storageState = await establishAuth(manifest.auth, worktree, endpoints, dir, {
          cgroupDir, logFile: join(dir, "auth-setup.log"), timeoutMs: 300_000,
        });
      } catch (error) {
        return await fail("auth", error);
      }
    }
    const record = { runId: options.runId, endpoints, storageState, launchedAt: new Date(started).toISOString(), readinessMs, fingerprint, cgroup: cgroupDir };
    await writeFile(join(dir, "instance.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
    await options.onStarted?.({ runId: options.runId, endpoints, storageState, readinessMs });
    return { launched, endpoints, storageState, readinessMs, fingerprint };
  };

  let current = await bringUp();
  return {
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
}
