import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { wrapInCgroup, type CgroupController } from "../agent/cgroup.js";

export function tail(text: string, lines = 40): string {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}

/** `MemAvailable` from a meminfo file in MB, or null when it cannot be read (non-Linux). */
export async function availableMb(meminfoPath: string): Promise<number | null> {
  const content = await readFile(meminfoPath, "utf8").catch(() => null);
  const match = content?.match(/^MemAvailable:\s+(\d+) kB/m);
  return match ? Math.floor(Number(match[1]) / 1024) : null;
}

export interface Launched {
  readonly child: ChildProcess;
  readonly cgroupDir: string | null;
  /** null while running; otherwise "exit code N" / "signal SIG…" / an error message. */
  exit(): string | null;
}

/** Starts the launcher detached (its own process group) inside `cgroupDir`, output appended to `logFile`. */
export function launch(argv: readonly string[], worktree: string, env: NodeJS.ProcessEnv, logFile: string, cgroupDir: string | null): Launched {
  const fd = openSync(logFile, "a", 0o600);
  const [command = "sh", ...args] = wrapInCgroup(cgroupDir, argv);
  const child = spawn(command, args, { cwd: worktree, env, stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  let exit: string | null = null;
  child.on("exit", (code, signal) => {
    exit = signal ? `signal ${signal}` : `exit code ${code}`;
  });
  child.on("error", (error) => {
    exit = error.message;
  });
  return { child, cgroupDir, exit: () => exit };
}

/**
 * SIGTERM first, so a launcher's own exit trap runs (GeoWiki drops its per-instance databases, Aspire
 * stops its resources); then everything still in the cgroup — orchestrator children included — is killed.
 */
export async function stopLaunched(launched: Launched, cgroups: CgroupController, graceMs = 30_000): Promise<void> {
  const { child } = launched;
  if (child.pid && launched.exit() === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    const deadline = Date.now() + graceMs;
    while (launched.exit() === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (launched.exit() === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone between the check and the signal
      }
    }
  }
  if (launched.cgroupDir) await cgroups.killAndRemove(launched.cgroupDir);
}
