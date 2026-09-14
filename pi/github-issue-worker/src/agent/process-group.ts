import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { cgroupController, wrapInCgroup, type CgroupController } from "./cgroup.js";
import { sandboxEnvironment } from "./sandbox.js";

/** Build tooling must not leave helpers behind: nodes die with their call anyway, these flags stop the retries. */
const BUILD_TOOLING_ENVIRONMENT = { MSBUILDNODEREUSE: "0", DOTNET_CLI_USE_MSBUILD_SERVER: "0" } as const;

export const ACTIVE_COMMAND_PROCESS_GROUP_FILE = "active-command-group.pid";

export function activeCommandProcessGroupPath(dataDir: string): string {
  return resolve(dataDir, ACTIVE_COMMAND_PROCESS_GROUP_FILE);
}

const SUPPORTS_POSIX_PROCESS_GROUPS = process.platform !== "win32";

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isMissingProcessGroupError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function readTrackedProcessGroupPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function clearTrackedProcessGroupFile(path: string, pid: number): void {
  try {
    if (readTrackedProcessGroupPid(path) === pid) unlinkSync(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  const killCheck = SUPPORTS_POSIX_PROCESS_GROUPS ? () => process.kill(-pid, 0) : () => process.kill(pid, 0);
  try {
    killCheck();
    return true;
  } catch (error) {
    if (isMissingProcessGroupError(error)) return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!isProcessGroupAlive(pid)) return;
    if (Date.now() >= deadline) {
      throw new Error(`${SUPPORTS_POSIX_PROCESS_GROUPS ? "Process group" : "Process"} ${pid} did not stop within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  const killTarget = SUPPORTS_POSIX_PROCESS_GROUPS ? -pid : pid;
  try {
    process.kill(killTarget, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessGroupError(error)) throw error;
    return;
  }
  try {
    await waitForProcessGroupExit(pid, 5_000);
    return;
  } catch {
    // Escalate below.
  }
  try {
    process.kill(killTarget, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessGroupError(error)) throw error;
    return;
  }
  await waitForProcessGroupExit(pid, 5_000);
}

export async function stopTrackedProcessGroup(processGroupFile: string): Promise<void> {
  const pid = readTrackedProcessGroupPid(processGroupFile);
  if (pid === null) {
    try {
      unlinkSync(processGroupFile);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return;
  }
  await terminateProcessGroup(pid);
  try {
    unlinkSync(processGroupFile);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export interface BashOperationOptions {
  /**
   * Wrap every command with the Anthropic Sandbox Runtime. When false the command runs through a plain
   * `bash -c`: the detached process group and child cgroup, credential scrub, timeout/abort handling and
   * the leftover background-process check below all still apply — they are the harness's own guarantees,
   * not bwrap's.
   */
  sandbox: boolean;
  shutdownSignal?: AbortSignal;
  environmentOverrides?: NodeJS.ProcessEnv;
  /** Child-cgroup fencing of each call; defaults to an unavailable (no-op) controller. */
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
      // The shim moves the shell into the child cgroup before exec, so every descendant — `setsid`,
      // `nohup`, double forks, orchestrator children — inherits it and none can outlive the call.
      const childCgroup = await cgroups.createChild(`bash-${sequence}`);
      const [executable = "bash", ...args] = wrapInCgroup(childCgroup, ["bash", "-c", wrappedCommand]);
      return await new Promise((resolveResult, reject) => {
        const child = spawn(executable, args, {
          cwd,
          detached: true,
          env: { ...sandboxEnvironment(), ...BUILD_TOOLING_ENVIRONMENT, ...environmentOverrides },
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (!child.pid) {
          reject(new Error("Failed to start bash process"));
          return;
        }
        try {
          writeFileSync(processGroupFile, `${child.pid}\n`, "utf8");
        } catch (error) {
          child.kill("SIGKILL");
          reject(error);
          return;
        }
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let stopPromise: Promise<void> | null = null;
        const stopCurrentProcessGroup = () => {
          stopPromise ??= (async () => {
            await stopTrackedProcessGroup(processGroupFile);
            if (childCgroup) await cgroups.killAndRemove(childCgroup);
          })();
          return stopPromise;
        };
        const abort = () => {
          void stopCurrentProcessGroup();
        };
        const cleanupListeners = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", abort);
          shutdownSignal?.removeEventListener("abort", abort);
        };
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            void stopCurrentProcessGroup();
          }, timeout * 1000);
          timeoutHandle.unref();
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        signal?.addEventListener("abort", abort, { once: true });
        shutdownSignal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted || shutdownSignal?.aborted) {
          void stopCurrentProcessGroup();
        }
        child.on("error", (error) => {
          cleanupListeners();
          void (async () => {
            if (child.pid) await stopCurrentProcessGroup();
            reject(error);
          })().catch(reject);
        });
        let settled = false;
        // A leftover that inherited the stdout pipe keeps "close" from firing until the tool timeout; the
        // cgroup shows it the moment the shell exits, so the call is ended and rejected right there.
        child.on("exit", () => {
          if (!childCgroup) return;
          void (async () => {
            const survivors = (await cgroups.procs(childCgroup).catch(() => [])).filter((pid) => pid !== child.pid);
            if (survivors.length === 0 || settled) return;
            settled = true;
            cleanupListeners();
            await stopCurrentProcessGroup();
            reject(new Error("bash command left background processes running"));
          })().catch(reject);
        });
        child.on("close", (code, closeSignal) => {
          void (async () => {
            if (settled) return;
            settled = true;
            cleanupListeners();
            const timedOutOrAborted = signal?.aborted || shutdownSignal?.aborted || timedOut;
            if (timedOutOrAborted) {
              await stopCurrentProcessGroup();
              reject(new Error(signal?.aborted || shutdownSignal?.aborted ? "aborted" : `timeout:${timeout}`));
              return;
            }
            if (closeSignal) {
              await stopCurrentProcessGroup();
              reject(new Error(`command terminated by ${closeSignal}`));
              return;
            }
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
          })().catch(reject);
        });
      });
    },
  };
}
