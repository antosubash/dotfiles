import { isAbsolute } from "node:path";

/** Field validators shared by the QA manifest parsers. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SAFE_RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const SAFE_HTTP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*$/;
export const SAFE_LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

export function parseArgv(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 1_024 || arg.includes("\0"))
  ) {
    throw new Error(`${context} argv is invalid`);
  }
  return [...value] as string[];
}

/** Literal environment values; `valuePattern` narrows what a value may be (resource names for envFromEndpoints). */
export function parseEnv(value: unknown, context: string, valuePattern?: RegExp): Record<string, string> {
  const env = object(value, context);
  const parsed: Record<string, string> = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!SAFE_ENV_NAME.test(name) || typeof raw !== "string" || raw.length > 256 || raw.includes("\0") ||
        (valuePattern && !valuePattern.test(raw))) {
      throw new Error(`${context} is invalid: ${name}`);
    }
    parsed[name] = raw;
  }
  return parsed;
}

export function parseNotes(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 500) throw new Error(`${context} notes are invalid`);
  return value;
}

export function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
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
