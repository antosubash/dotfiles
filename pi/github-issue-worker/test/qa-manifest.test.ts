import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadQaManifest } from "../src/qa-manifest.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-manifest-"));
  await mkdir(join(root, ".pi-worker"));
  return root;
}

test("QA manifest loads strict Aspire, preview, and argv command metadata", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify({
      version: 1,
      aspire: {
        apphost: "AppHost/AppHost.csproj",
        resources: { frontend: "example-frontend", api: "example-api" },
      },
      previews: {
        stats: { path: "/pagebuilder-styleshots?fixture=stats", category: "component" },
      },
      commands: { frontend: { argv: ["pnpm", "--filter", "app", "test"] } },
    }));
    assert.deepEqual(await loadQaManifest(root, ".pi-worker/qa.json"), {
      version: 1,
      aspire: {
        apphost: "AppHost/AppHost.csproj",
        resources: { frontend: "example-frontend", api: "example-api" },
      },
      previews: {
        stats: { path: "/pagebuilder-styleshots?fixture=stats", category: "component" },
      },
      commands: { frontend: { argv: ["pnpm", "--filter", "app", "test"] } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Eleven live conflict retries on IIASA.GeoWiki#501 all reached the stack, and every remaining failure was
// the verifier re-deriving the same repository facts differently each run: how to launch, what "ready"
// means, how to log in. A repository can now declare them — launch argv, readiness resources/paths, and an
// auth setup that produces a Playwright storage state (env values mapped from resolved endpoints) — so
// the verifier follows a procedure instead of hand-driving an OIDC form.
test("QA manifest declares launch, readiness, and storage-state authentication", async () => {
  const root = await fixture();
  try {
    const declared = {
      version: 1,
      aspire: { apphost: "AppHost/AppHost.csproj", resources: { frontend: "app-frontend", api: "app-api", auth: "app-auth" } },
      launch: { argv: ["./scripts/start-apphost.sh"], env: { GEOWIKI_DROP_DATABASES_ON_EXIT: "1" }, notes: "Isolated Aspire instance; frontend port derives from the slug." },
      readiness: { resources: ["api", "auth", "frontend"], paths: { api: "/api/abp/application-configuration", frontend: "/en" } },
      auth: {
        setup: { argv: ["pnpm", "--filter", "app", "exec", "playwright", "test", "e2e/tools/save-auth-state.setup.ts"], envFromEndpoints: { BASE_URL: "frontend" }, env: { E2E_IGNORE_HTTPS_ERRORS: "1" } },
        storageState: "frontend/apps/app/e2e/.auth/qa-state.json",
        notes: "Creates a run-scoped ContentEditor and logs in through the real OIDC flow.",
      },
    };
    await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify(declared));
    assert.deepEqual(await loadQaManifest(root, ".pi-worker/qa.json"), declared);
    for (const [value, pattern] of [
      [{ version: 1, launch: { argv: [] } }, /launch argv is invalid/],
      [{ version: 1, launch: { argv: ["x"], env: { "bad name": "1" } } }, /launch env is invalid/],
      [{ version: 1, readiness: { resources: ["ok"], paths: { api: "https://evil.test" } } }, /readiness path is unsafe/],
      [{ version: 1, auth: { storageState: "../outside.json" } }, /escapes the repository/],
      [{ version: 1, auth: { storageState: "s.json", setup: { argv: ["x"], envFromEndpoints: { BASE_URL: "nope!" } } } }, /envFromEndpoints is invalid/],
    ] as const) {
      await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify(value));
      await assert.rejects(loadQaManifest(root, ".pi-worker/qa.json"), pattern);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA manifest is optional but rejects symlinks and unsafe schemas", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "pi-worker-manifest-outside-"));
  try {
    assert.equal(await loadQaManifest(root, ".pi-worker/missing.json"), null);
    await writeFile(join(outside, "qa.json"), '{"version":1}');
    await symlink(join(outside, "qa.json"), join(root, ".pi-worker/qa.json"));
    await assert.rejects(loadQaManifest(root, ".pi-worker/qa.json"), /regular file|symlink/);
    await rm(join(root, ".pi-worker/qa.json"));

    for (const [value, pattern] of [
      [{ version: 1, unexpected: true }, /unknown key/],
      [{ version: 1, aspire: { apphost: "../outside.csproj" } }, /escapes the repository/],
      [{ version: 1, previews: { x: { path: "https://evil.test", category: "component" } } }, /unsafe/],
      [{ version: 1, commands: { test: { argv: "pnpm test" } } }, /argv is invalid/],
    ] as const) {
      await writeFile(join(root, ".pi-worker/qa.json"), JSON.stringify(value));
      await assert.rejects(loadQaManifest(root, ".pi-worker/qa.json"), pattern);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
