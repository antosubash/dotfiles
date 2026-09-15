import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
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
  /** Creates `<root>/<name>`; null when the controller is unavailable. */
  createChild(name: string): Promise<string | null>;
  procs(childDir: string): Promise<number[]>;
  /** `cgroup.kill`, wait until empty, remove. A no-op for a missing directory or an unavailable controller. */
  killAndRemove(childDir: string, timeoutMs?: number): Promise<void>;
  /** Kill and remove every child whose name starts with one of the prefixes; returns the removed names. */
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
    if (!available || !existsSync(childDir)) return;
    await writeFile(join(childDir, "cgroup.kill"), "1").catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    while ((await procs(childDir).catch(() => [])).length > 0) {
      if (Date.now() >= deadline) throw new Error(`cgroup ${childDir} still has processes after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A cgroup is removed with rmdir (its files cannot be unlinked); a plain directory standing in for
    // one in tests is not empty, so fall back to a recursive removal there.
    await rmdir(childDir).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOTEMPTY") await rm(childDir, { recursive: true, force: true });
    });
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
        // One child stuck past its kill timeout must not abort the sweep — a caller sweeping at startup
        // would otherwise never get past the stale entry to clean up the rest, or start at all.
        try {
          await killAndRemove(join(root!, entry.name));
          removed.push(entry.name);
        } catch {
          // Left for the next sweep; still-live processes there are not this call's problem to solve.
        }
      }
      return removed;
    },
  };
}
