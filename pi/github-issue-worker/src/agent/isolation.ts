import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { WorkerConfig } from "../config.js";
import type { CgroupController } from "./cgroup.js";
import type { VerificationOptions } from "./policy.js";
import { createBashOperations, stopTrackedProcessGroup } from "./process-group.js";
import {
  applySandboxTempEnvironment,
  assertVisualSandboxIsolation,
  removeStaleSandboxTemps,
  sandboxConfig,
  sandboxTempRoot,
} from "./sandbox.js";

export interface IsolationOptions {
  worktree: string;
  processGroupFile: string;
  visualVerification: boolean;
  dockerAccess: boolean;
  verification?: VerificationOptions;
  shutdownSignal: AbortSignal;
  /** Child-cgroup fencing for every bash call of this run. */
  cgroups?: CgroupController;
  /** Per-run variables for agent bash (a running app instance's endpoints, for example). */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Everything one agent run needs around its bash tool: a private temp directory, the bash operations the
 * Pi session executes commands through, and the teardown that stops stray processes and removes the
 * directory. Whether those commands additionally run inside the Anthropic Sandbox Runtime is decided by
 * `config.sandbox`; the rest of the contract is identical in both modes.
 */
export interface Isolation {
  readonly sandboxed: boolean;
  readonly privateTemp: string;
  readonly bashOperations: BashOperations;
  close(): Promise<void>;
}

export async function openIsolation(config: WorkerConfig, options: IsolationOptions): Promise<Isolation> {
  const { visualVerification, dockerAccess } = options;
  if (options.verification && dockerAccess) throw new Error("Independent verifiers cannot access the Docker daemon.");
  if (dockerAccess && (!config.allowDocker || !config.dockerSocket)) {
    throw new Error("Docker access was requested but is not enabled for this worker profile");
  }
  const sandboxed = config.sandbox;
  // The private user runtime (/run/user/<uid>) only matters for hiding host sockets from bwrap; an
  // unsandboxed run keeps its scratch space under /tmp like any other process of this user.
  const tempRoot = sandboxed ? sandboxTempRoot(visualVerification || dockerAccess) : "/tmp";
  await removeStaleSandboxTemps(tempRoot);
  const privateTemp = await mkdtemp(join(tempRoot, "piw-"));
  await writeFile(join(privateTemp, ".owner-pid"), `${process.pid}\n`, { mode: 0o600 });
  const restoreEnvironment = applySandboxTempEnvironment(
    privateTemp,
    Boolean(options.verification) || (visualVerification || dockerAccess) && process.platform === "linux",
  );
  const close = async (): Promise<void> => {
    try {
      await stopTrackedProcessGroup(options.processGroupFile);
    } finally {
      try {
        // Reset even after a failed initialize: the runtime may hold partial proxy state either way.
        if (sandboxed) await SandboxManager.reset();
      } finally {
        restoreEnvironment();
        await rm(privateTemp, { recursive: true, force: true });
      }
    }
  };
  try {
    if (sandboxed) {
      await SandboxManager.initialize(sandboxConfig(options.worktree, config, {
        privateTemp,
        visualVerification,
        dockerSocket: dockerAccess ? config.dockerSocket : null,
        ...(options.verification ? { verification: options.verification } : {}),
      }));
      if (process.platform === "linux" && (visualVerification || dockerAccess)) {
        assertVisualSandboxIsolation(await SandboxManager.wrapWithSandbox("true"));
      }
    }
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const bashOperations = createBashOperations(options.processGroupFile, {
    sandbox: sandboxed,
    shutdownSignal: options.shutdownSignal,
    environmentOverrides: {
      ...(dockerAccess && config.dockerSocket ? { DOCKER_HOST: `unix://${config.dockerSocket}` } : {}),
      ...(options.environment ?? {}),
    },
    ...(options.cgroups ? { cgroups: options.cgroups } : {}),
  });
  return { sandboxed, privateTemp, bashOperations, close };
}
