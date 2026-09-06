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

export async function apiPages<T>(gh: GhRunner, endpoint: string): Promise<T[]> {
  const output = await gh(["api", "--paginate", "--slurp", endpoint]);
  if (!output) return [];
  const pages = JSON.parse(output) as T[][];
  return pages.flat();
}
