import { execFile } from "../exec.js";

export type GhRunner = (args: readonly string[], input?: string) => Promise<string>;

export function createGhRunner(): GhRunner {
  return async (args, input) => {
    const result = await execFile("gh", args, {
      ...(input === undefined ? {} : { input }),
      timeoutMs: 120_000,
    });
    return result.stdout.trim();
  };
}

// gh prints "(HTTP 404)" or "HTTP 404:"; a bare "404" would misread errors whose command line contains it.
export function isNotFound(error: unknown): boolean {
  return /\(HTTP 404\)|\bHTTP 404:/.test(String(error));
}

export async function apiPages<T>(gh: GhRunner, endpoint: string): Promise<T[]> {
  const output = await gh(["api", "--paginate", "--slurp", endpoint]);
  if (!output) return [];
  const pages = JSON.parse(output) as T[][];
  return pages.flat();
}
