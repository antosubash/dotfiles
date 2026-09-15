import assert from "node:assert/strict";
import test from "node:test";
import { endpointsFromAspire, resolveEndpoints } from "../src/app-instance/endpoints.js";

const running = (displayName: string, url: string) => ({ displayName, state: "Running", urls: [{ name: "http", url }] });

test("endpointsFromAspire maps manifest keys to running resources' first URL", () => {
  const { endpoints, missing } = endpointsFromAspire(
    [
      running("geowiki-frontend", "http://localhost:3005"),
      { displayName: "geowiki-api", state: "Starting", urls: [] },
      { displayName: "geowiki-frontend-installer", state: "Finished" },
    ],
    { frontend: "geowiki-frontend", api: "geowiki-api" },
    ["frontend", "api"],
  );
  assert.deepEqual(endpoints, { frontend: "http://localhost:3005" });
  assert.deepEqual(missing, ["api"]);
});

test("endpointsFromAspire picks the browser binding by name, not by position", () => {
  const { endpoints } = endpointsFromAspire(
    [
      { displayName: "api", state: "Running", urls: [{ name: "internal", url: "tcp://localhost:5000" }, { name: "https", url: "https://localhost:7001" }, { name: "http", url: "http://localhost:5001" }] },
      { displayName: "web", state: "Running", urls: [{ name: "grpc", url: "tcp://localhost:9000" }, { url: "http://localhost:3000" }] },
    ],
    { api: "api", web: "web" },
    ["api", "web"],
  );
  assert.deepEqual(endpoints, { api: "https://localhost:7001", web: "http://localhost:3000" });
});

test("resolveEndpoints polls describe until every required key is running", async () => {
  let calls = 0;
  const describe = async () => {
    calls += 1;
    return calls < 3
      ? [running("geowiki-frontend", "http://localhost:3005")]
      : [running("geowiki-frontend", "http://localhost:3005"), running("geowiki-api", "https://localhost:44431")];
  };
  const manifest = {
    version: 1 as const,
    aspire: { apphost: "App/App.csproj", resources: { frontend: "geowiki-frontend", api: "geowiki-api" } },
    readiness: { resources: ["frontend", "api"] },
  };
  const endpoints = await resolveEndpoints(manifest, "/w", { describe, deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => null });
  assert.deepEqual(endpoints, { frontend: "http://localhost:3005", api: "https://localhost:44431" });
  assert.equal(calls, 3);
});

test("resolveEndpoints fails fast when the launcher exits and on timeout", async () => {
  const manifest = { version: 1 as const, aspire: { apphost: "A.csproj", resources: { api: "x" } } };
  await assert.rejects(
    resolveEndpoints(manifest, "/w", { describe: async () => [], deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => "exit code 1" }),
    /launcher exited \(exit code 1\)/,
  );
  await assert.rejects(
    resolveEndpoints(manifest, "/w", { describe: async () => [], deadline: Date.now() + 20, intervalMs: 5, launcherExited: () => null }),
    /not running after the start timeout: api/,
  );
});

test("static readiness.endpoints need no resolution", async () => {
  const manifest = { version: 1 as const, readiness: { endpoints: { frontend: "http://localhost:3000" } } };
  assert.deepEqual(
    await resolveEndpoints(manifest, "/w", { describe: async () => { throw new Error("never"); }, deadline: Date.now() + 100, intervalMs: 5, launcherExited: () => null }),
    { frontend: "http://localhost:3000" },
  );
});

test("a launch without aspire.resources or readiness.endpoints is a manifest error", async () => {
  await assert.rejects(
    resolveEndpoints({ version: 1 }, "/w", { describe: async () => [], deadline: Date.now() + 100, intervalMs: 5, launcherExited: () => null }),
    /neither aspire\.resources nor readiness\.endpoints/,
  );
});
