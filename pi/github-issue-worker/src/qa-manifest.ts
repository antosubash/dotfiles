import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseAuth } from "./qa-manifest-auth.js";
import {
  object, onlyKeys, parseArgv, parseEnv, parseNotes, SAFE_ENV_NAME, SAFE_HTTP_PATH, SAFE_LOOPBACK_URL, SAFE_NAME, SAFE_RESOURCE,
  safeRepositoryPath,
} from "./qa-manifest-fields.js";

export { safeRepositoryPath } from "./qa-manifest-fields.js";

export type QaPreviewCategory = "component" | "source" | "integrated";

export interface QaPreview {
  path: string;
  category: QaPreviewCategory;
  description?: string;
}

export interface QaCommand {
  argv: string[];
}

/** How to start the repository's stack for QA: a literal argv, optional literal env, a short human note. */
export interface QaLaunch {
  argv: string[];
  env?: Record<string, string>;
  /**
   * A variable the worker sets to a fresh `pi<issue>_<hex>` name on every launch, for launchers that key
   * databases and cache prefixes off an instance name: a relaunch then never meets the previous launch's
   * cached state (GeoWiki's AuthServer cached a deleted OpenIddict client id across a relaunch).
   */
  instanceEnv?: string;
  notes?: string;
}

/** What must answer before a browser opens: Aspire resource names, or static loopback `endpoints` for other launchers, plus probe paths. */
export interface QaReadiness {
  resources?: string[];
  endpoints?: Record<string, string>;
  paths?: Record<string, string>;
}

/**
 * Authentication for a freshly launched instance: `setup` runs a repository command that logs in through the
 * real flow and writes a Playwright storage state to `storageState`; `envFromEndpoints` maps env names to
 * `aspire.resources` keys whose resolved URLs the agent must supply, so the setup targets THIS instance.
 */
export interface QaAuth {
  storageState: string;
  setup?: { argv: string[]; env?: Record<string, string>; envFromEndpoints?: Record<string, string> };
  /**
   * Extra roles beside the default one: each reruns `setup` with its `env` merged over `setup.env` and reads
   * its own `storageState`, so a verifier can reach pages the default role is (correctly) denied.
   */
  roles?: Record<string, { env?: Record<string, string>; storageState: string }>;
  notes?: string;
}

export interface QaManifest {
  version: 1;
  aspire?: {
    apphost: string;
    resources?: Record<string, string>;
  };
  previews?: Record<string, QaPreview>;
  commands?: Record<string, QaCommand>;
  launch?: QaLaunch;
  readiness?: QaReadiness;
  auth?: QaAuth;
}

export const MAX_MANIFEST_BYTES = 64 * 1024;

export function parseManifest(raw: unknown): QaManifest {
  const root = object(raw, "QA manifest");
  onlyKeys(root, ["version", "aspire", "previews", "commands", "launch", "readiness", "auth"], "QA manifest");
  if (root.version !== 1) throw new Error("QA manifest version must be 1");
  const manifest: QaManifest = { version: 1 };

  if (root.aspire !== undefined) {
    const aspire = object(root.aspire, "QA manifest aspire");
    onlyKeys(aspire, ["apphost", "resources"], "QA manifest aspire");
    if (typeof aspire.apphost !== "string") throw new Error("QA manifest aspire.apphost must be a string");
    const parsedAspire: NonNullable<QaManifest["aspire"]> = {
      apphost: safeRepositoryPath(aspire.apphost, "QA manifest aspire.apphost"),
    };
    if (aspire.resources !== undefined) {
      const resources = object(aspire.resources, "QA manifest aspire.resources");
      parsedAspire.resources = {};
      for (const [name, resource] of Object.entries(resources)) {
        if (!SAFE_NAME.test(name) || typeof resource !== "string" || !SAFE_RESOURCE.test(resource)) {
          throw new Error(`QA manifest Aspire resource is invalid: ${name}`);
        }
        parsedAspire.resources[name] = resource;
      }
    }
    manifest.aspire = parsedAspire;
  }

  if (root.previews !== undefined) {
    const previews = object(root.previews, "QA manifest previews");
    manifest.previews = {};
    for (const [name, rawPreview] of Object.entries(previews)) {
      if (!SAFE_NAME.test(name)) throw new Error(`QA manifest preview name is invalid: ${name}`);
      const preview = object(rawPreview, `QA manifest preview ${name}`);
      onlyKeys(preview, ["path", "category", "description"], `QA manifest preview ${name}`);
      if (
        typeof preview.path !== "string" ||
        !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*$/.test(preview.path) ||
        preview.path.startsWith("//") ||
        preview.path.includes("..")
      ) {
        throw new Error(`QA manifest preview path is unsafe: ${name}`);
      }
      if (!(["component", "source", "integrated"] as unknown[]).includes(preview.category)) {
        throw new Error(`QA manifest preview category is invalid: ${name}`);
      }
      if (
        preview.description !== undefined &&
        (typeof preview.description !== "string" || preview.description.length > 500)
      ) {
        throw new Error(`QA manifest preview description is invalid: ${name}`);
      }
      manifest.previews[name] = {
        path: preview.path,
        category: preview.category as QaPreviewCategory,
        ...(preview.description === undefined ? {} : { description: preview.description as string }),
      };
    }
  }

  if (root.commands !== undefined) {
    const commands = object(root.commands, "QA manifest commands");
    manifest.commands = {};
    for (const [name, rawCommand] of Object.entries(commands)) {
      if (!SAFE_NAME.test(name)) throw new Error(`QA manifest command name is invalid: ${name}`);
      const command = object(rawCommand, `QA manifest command ${name}`);
      onlyKeys(command, ["argv"], `QA manifest command ${name}`);
      if (
        !Array.isArray(command.argv) ||
        command.argv.length === 0 ||
        command.argv.length > 32 ||
        command.argv.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 1_024 || arg.includes("\0"))
      ) {
        throw new Error(`QA manifest command argv is invalid: ${name}`);
      }
      manifest.commands[name] = { argv: [...command.argv] as string[] };
    }
  }

  if (root.launch !== undefined) {
    const launch = object(root.launch, "QA manifest launch");
    onlyKeys(launch, ["argv", "env", "instanceEnv", "notes"], "QA manifest launch");
    if (launch.instanceEnv !== undefined && (typeof launch.instanceEnv !== "string" || !SAFE_ENV_NAME.test(launch.instanceEnv))) {
      throw new Error("QA manifest launch instanceEnv must be an environment variable name");
    }
    const notes = parseNotes(launch.notes, "QA manifest launch");
    manifest.launch = {
      argv: parseArgv(launch.argv, "QA manifest launch"),
      ...(launch.env === undefined ? {} : { env: parseEnv(launch.env, "QA manifest launch env") }),
      ...(launch.instanceEnv === undefined ? {} : { instanceEnv: launch.instanceEnv as string }),
      ...(notes === undefined ? {} : { notes }),
    };
  }

  if (root.readiness !== undefined) {
    const readiness = object(root.readiness, "QA manifest readiness");
    onlyKeys(readiness, ["resources", "endpoints", "paths"], "QA manifest readiness");
    manifest.readiness = {};
    if (readiness.endpoints !== undefined) {
      manifest.readiness.endpoints = {};
      for (const [name, url] of Object.entries(object(readiness.endpoints, "QA manifest readiness.endpoints"))) {
        if (!SAFE_NAME.test(name) || typeof url !== "string" || !SAFE_LOOPBACK_URL.test(url) || url.includes("..")) {
          throw new Error(`QA manifest readiness.endpoints entry is not a loopback http(s) URL: ${name}`);
        }
        manifest.readiness.endpoints[name] = url;
      }
    }
    if (readiness.resources !== undefined) {
      if (!Array.isArray(readiness.resources) || readiness.resources.some((name) => typeof name !== "string" || !SAFE_NAME.test(name))) {
        throw new Error("QA manifest readiness resources are invalid");
      }
      manifest.readiness.resources = [...readiness.resources] as string[];
    }
    if (readiness.paths !== undefined) {
      const paths = object(readiness.paths, "QA manifest readiness paths");
      manifest.readiness.paths = {};
      for (const [name, path] of Object.entries(paths)) {
        if (!SAFE_NAME.test(name) || typeof path !== "string" || !SAFE_HTTP_PATH.test(path) || path.startsWith("//") || path.includes("..")) {
          throw new Error(`QA manifest readiness path is unsafe: ${name}`);
        }
        manifest.readiness.paths[name] = path;
      }
    }
  }

  if (root.auth !== undefined) manifest.auth = parseAuth(root.auth);
  return manifest;
}

async function assertNoSymlinkPath(worktree: string, target: string): Promise<void> {
  let current = target;
  while (current !== worktree) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`QA manifest path contains a symlink: ${current}`);
    current = dirname(current);
    if (!current.startsWith(`${worktree}${sep}`) && current !== worktree) {
      throw new Error("QA manifest escapes the worktree");
    }
  }
}

export async function loadQaManifest(
  worktree: string,
  configuredPath: string,
): Promise<QaManifest | null> {
  const canonicalWorktree = await realpath(worktree).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!canonicalWorktree) return null;
  const relativePath = safeRepositoryPath(configuredPath, "PI_WORKER_QA_MANIFEST");
  const target = resolve(canonicalWorktree, relativePath);
  if (relative(canonicalWorktree, target).startsWith("..")) {
    throw new Error("QA manifest escapes the worktree");
  }
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("QA manifest must be a regular file");
  if (info.size > MAX_MANIFEST_BYTES) throw new Error("QA manifest exceeds 64 KiB");
  await assertNoSymlinkPath(canonicalWorktree, target);
  if ((await realpath(target)) !== target) throw new Error("QA manifest path is not canonical");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`QA manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(raw);
}
