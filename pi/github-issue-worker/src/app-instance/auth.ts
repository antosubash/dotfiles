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
export interface AuthStates {
  /** The default role's storage state. */
  storageState: string;
  /** Storage states of `auth.roles`, by role name. */
  roleStorageStates: Record<string, string>;
}

export async function establishAuth(
  auth: QaAuth,
  worktree: string,
  endpoints: Endpoints,
  instanceDir: string,
  options: { cgroupDir: string | null; logFile: string; timeoutMs: number },
): Promise<AuthStates> {
  await mkdir(instanceDir, { recursive: true, mode: 0o700 });
  const storageState = await establishRole(auth, worktree, endpoints, options, {
    env: {}, storageState: auth.storageState, copy: join(instanceDir, "storage-state.json"), label: "auth",
  });
  const roleStorageStates: Record<string, string> = {};
  for (const [name, role] of Object.entries(auth.roles ?? {})) {
    roleStorageStates[name] = await establishRole(auth, worktree, endpoints, options, {
      env: role.env ?? {}, storageState: role.storageState, copy: join(instanceDir, `storage-state.${name}.json`), label: `auth.roles.${name}`,
    });
  }
  return { storageState, roleStorageStates };
}

async function establishRole(
  auth: QaAuth,
  worktree: string,
  endpoints: Endpoints,
  options: { cgroupDir: string | null; logFile: string; timeoutMs: number },
  role: { env: Record<string, string>; storageState: string; copy: string; label: string },
): Promise<string> {
  const ignored = await execFile("git", ["check-ignore", "-q", "--", role.storageState], { cwd: worktree }).then(() => true, () => false);
  if (!ignored) throw new Error(`${role.label} storageState must be gitignored by the repository: ${role.storageState}`);
  if (auth.setup) {
    const env: NodeJS.ProcessEnv = { ...sandboxEnvironment(), ...(auth.setup.env ?? {}), ...role.env };
    for (const [name, key] of Object.entries(auth.setup.envFromEndpoints ?? {})) {
      const url = endpoints[key];
      if (!url) throw new Error(`auth.setup.envFromEndpoints names unknown endpoint: ${key}`);
      env[name] = url;
    }
    const [command = "sh", ...args] = wrapInCgroup(options.cgroupDir, auth.setup.argv);
    const result = await execFile(command, args, { cwd: worktree, env, timeoutMs: options.timeoutMs, allowFailure: true, maxOutputChars: 200_000 });
    await appendFile(options.logFile, `# ${role.label}\n$ ${auth.setup.argv.join(" ")}\n${result.stdout}${result.stderr}\nexit ${result.exitCode}\n`, { mode: 0o600 });
    if (result.exitCode !== 0) {
      throw new Error(`${role.label} setup exited ${result.exitCode}\n--- auth-setup.log (tail) ---\n${tail(`${result.stdout}\n${result.stderr}`)}`);
    }
  }
  await copyFile(resolve(worktree, role.storageState), role.copy).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`${role.label} storageState was not produced: ${role.storageState} (${error.code ?? error.message})`);
  });
  return role.copy;
}
