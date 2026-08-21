import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { loadConfig, type WorkerConfig } from "./config.js";

export type SupervisorMode = "run" | "check" | "once";

export interface SupervisorOptions {
  configDir: string;
  profiles: readonly string[];
  mode: SupervisorMode;
  restartSeconds: number;
}

export interface SupervisorProfile {
  name: string;
  path: string;
  env: NodeJS.ProcessEnv;
  config: WorkerConfig;
}

function expandPath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function positiveInteger(name: string, value: string, fallback: number): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function profileName(value: string): string {
  const normalized = value.endsWith(".env") ? value.slice(0, -4) : value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid profile name: ${value}`);
  }
  return normalized;
}

export function parseSupervisorOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SupervisorOptions {
  const profiles: string[] = [];
  let configDir = env.PI_WORKER_SUPERVISOR_CONFIG_DIR?.trim() || "~/.config/pi-issue-worker";
  let mode: SupervisorMode = "run";
  let modeSelected = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config-dir" || argument === "--profile") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--config-dir") configDir = value;
      else profiles.push(profileName(value));
      index += 1;
      continue;
    }
    if (argument === "--check" || argument === "--once") {
      if (modeSelected) throw new Error("Use only one of --check or --once");
      mode = argument === "--check" ? "check" : "once";
      modeSelected = true;
      continue;
    }
    throw new Error(`Unknown supervisor argument: ${argument}`);
  }

  const home = env.HOME || homedir();
  return {
    configDir: expandPath(configDir, home),
    profiles: [...new Set(profiles)],
    mode,
    restartSeconds: positiveInteger(
      "PI_WORKER_SUPERVISOR_RESTART_SECONDS",
      env.PI_WORKER_SUPERVISOR_RESTART_SECONDS || "",
      15,
    ),
  };
}

const PROFILE_SECRET_ENV = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

function childEnvironment(parent: NodeJS.ProcessEnv, profile: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (!name.startsWith("PI_WORKER_") && !PROFILE_SECRET_ENV.has(name)) child[name] = value;
  }
  return { ...child, ...profile };
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertPrivateConfigDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Profile config path must be a directory, not a symlink: ${path}`);
  }
  if (platform() !== "win32" && (info.mode & 0o022) !== 0) {
    throw new Error(`Profile config directory must not be group/world writable: ${path}`);
  }
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Profile must be a regular file, not a symlink: ${path}`);
  }
  if (platform() !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Profile permissions must be 0600 (or stricter): ${path}`);
  }
}

export async function loadSupervisorProfiles(
  options: SupervisorOptions,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<SupervisorProfile[]> {
  await assertPrivateConfigDirectory(options.configDir);
  const entries = await readdir(options.configDir, { withFileTypes: true });
  const available = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".env"))
    .map((entry) => entry.name.slice(0, -4))
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    .sort();
  const selected = options.profiles.length > 0 ? options.profiles : available;
  if (selected.length === 0) {
    throw new Error(`No repository profiles found in ${options.configDir}`);
  }
  for (const name of selected) {
    if (!available.includes(name)) throw new Error(`Repository profile not found: ${name}`);
  }

  const profiles: SupervisorProfile[] = [];
  const repositories = new Map<string, string>();
  const dataDirectories = new Map<string, string>();
  for (const name of selected) {
    const path = join(options.configDir, `${name}.env`);
    await assertPrivateRegularFile(path);
    const values = parseEnv(await readFile(path, "utf8"));
    const env = childEnvironment(parentEnv, values);
    const config = loadConfig(env);
    const repositoryKey = config.repository.toLowerCase();
    const previousRepository = repositories.get(repositoryKey);
    if (previousRepository) {
      throw new Error(`Profiles ${previousRepository} and ${name} target the same repository`);
    }
    const dataKey = await canonicalizePotentialPath(config.dataDir);
    const previousData = dataDirectories.get(dataKey);
    if (previousData) {
      throw new Error(`Profiles ${previousData} and ${name} share PI_WORKER_DATA_DIR ${dataKey}`);
    }
    repositories.set(repositoryKey, name);
    dataDirectories.set(dataKey, name);
    // Freeze the validated selection so a legacy directory appearing later cannot redirect the child.
    env.PI_WORKER_DATA_DIR = config.dataDir;
    env.PI_WORKER_PROFILE = name;
    profiles.push({ name, path, env, config });
  }
  return profiles;
}
