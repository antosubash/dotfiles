import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Endpoints } from "./endpoints.js";

/** HTTP status of a GET, or a rejection when no server answers. */
export type Probe = (url: string) => Promise<number>;

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * GET without following redirects; a 3xx is "the server is up". The repository's dev certificates are
 * self-signed, so certificate verification is skipped for loopback hosts only — nothing else is ever
 * probed (the manifest admits loopback URLs only, and Aspire allocates loopback endpoints), and the
 * probe reads a status code, never a body it would trust.
 */
export const httpProbe: Probe = (url) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!LOOPBACK.test(target.hostname)) {
      reject(new Error(`readiness probes only loopback hosts: ${target.hostname}`));
      return;
    }
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: "GET", timeout: 10_000, rejectUnauthorized: false, headers: { accept: "*/*" } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });

/** Polls every `paths` entry against its endpoint until all answer, the launcher dies, or the deadline passes. */
export async function waitForReadiness(
  endpoints: Endpoints,
  paths: Record<string, string>,
  options: { probe: Probe; deadline: number; intervalMs: number; launcherExited: () => string | null },
): Promise<Record<string, number>> {
  const unknown = Object.keys(paths).filter((key) => !(key in endpoints));
  if (unknown.length > 0) throw new Error(`readiness.paths names unknown endpoint: ${unknown.join(", ")}`);
  const statuses: Record<string, number> = {};
  const failures: Record<string, string> = {};
  const pending = new Set(Object.keys(paths));
  while (pending.size > 0) {
    const exit = options.launcherExited();
    if (exit) throw new Error(`launcher exited (${exit}) before readiness`);
    for (const key of [...pending]) {
      const url = `${(endpoints[key] ?? "").replace(/\/$/, "")}${paths[key]}`;
      try {
        const status = await options.probe(url);
        if (status >= 200 && status < 400) {
          statuses[key] = status;
          pending.delete(key);
        } else {
          failures[key] = `${key} ${url}: HTTP ${status}`;
        }
      } catch (error) {
        failures[key] = `${key} ${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (pending.size === 0) break;
    if (Date.now() >= options.deadline) {
      throw new Error(`readiness timed out — ${[...pending].map((key) => failures[key]).join("; ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  return statuses;
}
