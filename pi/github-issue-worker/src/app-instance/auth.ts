import { appendFile, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { wrapInCgroup } from "../agent/cgroup.js";
import { sandboxEnvironment } from "../agent/sandbox.js";
import { execFile } from "../exec.js";
import type { QaAuth } from "../qa-manifest.js";
import type { Endpoints } from "./endpoints.js";
import { tail } from "./process.js";

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
      const url = endpoints[key];
      if (!url) throw new Error(`auth.setup.envFromEndpoints names unknown endpoint: ${key}`);
      env[name] = url;
    }
    const [command = "sh", ...args] = wrapInCgroup(options.cgroupDir, auth.setup.argv);
    const result = await execFile(command, args, { cwd: worktree, env, timeoutMs: options.timeoutMs, allowFailure: true, maxOutputChars: 200_000 });
    await appendFile(options.logFile, `$ ${auth.setup.argv.join(" ")}\n${result.stdout}${result.stderr}\nexit ${result.exitCode}\n`, { mode: 0o600 });
    if (result.exitCode !== 0) {
      throw new Error(`auth.setup exited ${result.exitCode}\n--- auth-setup.log (tail) ---\n${tail(`${result.stdout}\n${result.stderr}`)}`);
    }
  }
  await mkdir(instanceDir, { recursive: true, mode: 0o700 });
  const copy = join(instanceDir, "storage-state.json");
  await copyFile(resolve(worktree, auth.storageState), copy).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`auth.storageState was not produced: ${auth.storageState} (${error.code ?? error.message})`);
  });
  return copy;
}
