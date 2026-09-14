import { execFile } from "../exec.js";
import type { QaManifest } from "../qa-manifest.js";

export interface AspireResource {
  displayName: string;
  state?: string;
  urls?: Array<{ name?: string; url: string }>;
}

/** Resource key (as named in the manifest) → resolved base URL. */
export type Endpoints = Record<string, string>;

export type DescribeAspire = (worktree: string, apphost: string) => Promise<AspireResource[]>;

/** `aspire describe` reports the running AppHost's resources with their allocated URLs; ports are never guessed. */
export const describeAspire: DescribeAspire = async (worktree, apphost) => {
  const { stdout } = await execFile(
    "aspire",
    ["describe", "--apphost", apphost, "--format", "Json", "--non-interactive"],
    { cwd: worktree, timeoutMs: 60_000 },
  );
  const parsed = JSON.parse(stdout) as { resources?: AspireResource[] };
  return Array.isArray(parsed.resources) ? parsed.resources : [];
};

export function endpointsFromAspire(
  resources: AspireResource[],
  wanted: Record<string, string>,
  required: readonly string[],
): { endpoints: Endpoints; missing: string[] } {
  const endpoints: Endpoints = {};
  const missing: string[] = [];
  for (const [key, displayName] of Object.entries(wanted)) {
    const resource = resources.find((entry) => entry.displayName === displayName);
    const url = resource?.state === "Running" ? resource.urls?.[0]?.url : undefined;
    if (url) endpoints[key] = url;
    else if (required.includes(key)) missing.push(key);
  }
  return { endpoints, missing };
}

/**
 * Static `readiness.endpoints` are taken as declared; otherwise `aspire describe` is polled until every
 * `readiness.resources` key (default: every `aspire.resources` key) is Running with a URL.
 */
export async function resolveEndpoints(
  manifest: QaManifest,
  worktree: string,
  options: { describe: DescribeAspire; deadline: number; intervalMs: number; launcherExited: () => string | null },
): Promise<Endpoints> {
  if (manifest.readiness?.endpoints) return { ...manifest.readiness.endpoints };
  if (!manifest.aspire) throw new Error("QA manifest declares launch but neither aspire.resources nor readiness.endpoints");
  const wanted = manifest.aspire.resources ?? {};
  const required = manifest.readiness?.resources ?? Object.keys(wanted);
  let lastMissing: string[] = [...required];
  while (true) {
    const exit = options.launcherExited();
    if (exit) throw new Error(`launcher exited (${exit}) before its endpoints were resolved`);
    const resources = await options.describe(worktree, manifest.aspire.apphost).catch(() => [] as AspireResource[]);
    const { endpoints, missing } = endpointsFromAspire(resources, wanted, required);
    if (missing.length === 0) return endpoints;
    lastMissing = missing;
    if (Date.now() >= options.deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new Error(`resources not running after the start timeout: ${lastMissing.join(", ")}`);
}
