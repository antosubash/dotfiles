import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sandboxEnvironment } from "./sandbox.js";

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

export function createSandboxedBashOperations(
  processGroupFile: string,
  shutdownSignal?: AbortSignal,
  environmentOverrides: NodeJS.ProcessEnv = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
      return await new Promise((resolveResult, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          detached: true,
          env: { ...sandboxEnvironment(), ...environmentOverrides },
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (!child.pid) {
          reject(new Error("Failed to start sandboxed bash process"));
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
          stopPromise ??= stopTrackedProcessGroup(processGroupFile);
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
        child.on("close", (code, closeSignal) => {
          void (async () => {
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
            if (pid !== undefined && isProcessGroupAlive(pid)) {
              await stopCurrentProcessGroup();
              reject(new Error("sandboxed bash left background processes running"));
              return;
            }
            if (pid !== undefined) clearTrackedProcessGroupFile(processGroupFile, pid);
            resolveResult({ exitCode: code });
          })().catch(reject);
        });
      });
    },
  };
}
