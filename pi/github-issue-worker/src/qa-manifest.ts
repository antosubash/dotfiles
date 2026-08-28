import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type QaPreviewCategory = "component" | "source" | "integrated";

export interface QaPreview {
  path: string;
  category: QaPreviewCategory;
  description?: string;
}

export interface QaCommand {
  argv: string[];
}

export interface QaManifest {
  version: 1;
  aspire?: {
    apphost: string;
    resources?: Record<string, string>;
  };
  previews?: Record<string, QaPreview>;
  commands?: Record<string, QaCommand>;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${context} contains unknown key: ${unexpected}`);
}

export function safeRepositoryPath(value: string, context: string): string {
  if (!value || isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${context} must be a non-empty repository-relative path`);
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${context} escapes the repository`);
  }
  return normalized;
}

function parseManifest(raw: unknown): QaManifest {
  const root = object(raw, "QA manifest");
  onlyKeys(root, ["version", "aspire", "previews", "commands"], "QA manifest");
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
