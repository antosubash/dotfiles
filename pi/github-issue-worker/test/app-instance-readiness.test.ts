import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { httpProbe, waitForReadiness } from "../src/app-instance/readiness.js";

test("waitForReadiness polls each declared path until it answers 2xx/3xx", async () => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (request.url === "/en") {
      response.statusCode = hits < 3 ? 503 : 302;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const endpoints = { frontend: `http://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}` };
  try {
    const statuses = await waitForReadiness(endpoints, { frontend: "/en", api: "/api/health" }, {
      probe: httpProbe, deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => null,
    });
    assert.deepEqual(statuses, { frontend: 302, api: 200 });
  } finally {
    server.close();
  }
});

test("waitForReadiness reports the failing path on timeout and the launcher exit first", async () => {
  const probe = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(
    waitForReadiness({ api: "http://127.0.0.1:1" }, { api: "/health" }, { probe, deadline: Date.now() + 30, intervalMs: 5, launcherExited: () => null }),
    /api http:\/\/127\.0\.0\.1:1\/health: ECONNREFUSED/,
  );
  await assert.rejects(
    waitForReadiness({ api: "http://127.0.0.1:1" }, { api: "/health" }, { probe, deadline: Date.now() + 5_000, intervalMs: 5, launcherExited: () => "signal SIGKILL" }),
    /launcher exited \(signal SIGKILL\)/,
  );
});

test("the probe refuses non-loopback hosts outright", async () => {
  await assert.rejects(httpProbe("https://example.com/"), /only loopback hosts/);
});

test("a path for an unknown endpoint is a manifest error, not a wait", async () => {
  await assert.rejects(
    waitForReadiness({ api: "http://127.0.0.1:1" }, { frontend: "/" }, { probe: async () => 200, deadline: Date.now() + 100, intervalMs: 5, launcherExited: () => null }),
    /readiness\.paths names unknown endpoint: frontend/,
  );
});
