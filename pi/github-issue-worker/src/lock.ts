import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export class ProfileLock {
  private constructor(private readonly path: string, private readonly handle: Awaited<ReturnType<typeof open>>) {}

  static async acquire(dataDir: string): Promise<ProfileLock> {
    await mkdir(dataDir, { recursive: true });
    const path = join(dataDir, "worker.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
          return new ProfileLock(path, handle);
        } catch (writeError) {
          await handle.close().catch(() => undefined);
          await rm(path, { force: true }).catch(() => undefined);
          throw writeError;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const contents = await readFile(path, "utf8").catch(() => "");
        let pid: number | null = null;
        try {
          const parsed = JSON.parse(contents) as { pid?: unknown };
          if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
            pid = parsed.pid;
          }
        } catch {
          // A malformed lock is unsafe to reclaim.
        }
        if (pid === null || processIsAlive(pid)) {
          throw new Error(
            pid === null
              ? `Worker profile is locked by an unreadable lock file: ${path}`
              : `Worker profile is already running (pid ${pid}): ${path}`,
          );
        }
        await rm(path);
      }
    }
    throw new Error(`Could not acquire worker profile lock: ${path}`);
  }

  async release(): Promise<void> {
    await this.handle.close();
    await rm(this.path, { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
