import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeedbackPrompt,
  buildIssuePrompt,
  buildUiVerificationPrompt,
} from "../src/prompts.js";
import type { WorkerConfig } from "../src/config.js";
import type { GitHubIssue, PullRequestFeedback } from "../src/types.js";

test("issue and feedback prompts reject seed edits for runtime-managed content fixes", () => {
  const config = { appUrl: null, playwrightState: null } as WorkerConfig;
  const issue = {
    number: 548,
    title: "Change CMS heading alignment",
    body: "Adjust the learning materials page content",
    url: "https://example.test/issues/548",
    updatedAt: "2026-08-24T00:00:00Z",
    labels: [],
    author: { login: "maintainer" },
  } satisfies GitHubIssue;
  const feedback = [{
    eventKey: "comment:1",
    source: "conversation",
    id: 1,
    body: "/pi this is CMS content only",
    author: "maintainer",
    authorAssociation: "OWNER",
    createdAt: "2026-08-24T00:00:00Z",
    url: null,
  }] satisfies PullRequestFeedback[];

  for (const prompt of [
    buildIssuePrompt({ config, issue, evidenceDir: null }),
    buildFeedbackPrompt({
      config,
      issueNumber: 548,
      prNumber: 552,
      feedback,
      evidenceDir: null,
      gifRequested: false,
    }),
  ]) {
    assert.match(prompt, /determine whether the repository treats it as canonical product source/);
    assert.match(prompt, /do not update seed scripts, seed payloads, fixtures, migrations, snapshots/);
    assert.match(prompt, /Do not mutate remote runtime content from this worker/);
    assert.match(prompt, /end with BLOCKED and provide a precise operator runbook/);
    assert.match(prompt, /target environment and tenant, page\/entity and slug/);
    assert.match(prompt, /restore the seed content to its base intent/);
    assert.match(prompt, /authoritative production source rather than a seeder/);
  }
});

test("visual verification prefers truthful source-backed previews over unrelated full stacks", () => {
  const prompt = buildUiVerificationPrompt({
    config: { appUrl: null, playwrightState: null, sandbox: true } as WorkerConfig,
    issueNumber: 548,
    prNumber: null,
    evidenceDir: ".qa/issues/548/pr-pending/runs/example",
    qaManifest: {
      version: 1,
      aspire: {
        apphost: "AppHost/AppHost.csproj",
        resources: { frontend: "example-frontend" },
      },
      previews: {
        stats: { path: "/styleshots?fixture=stats", category: "component" },
      },
      commands: { frontend: { argv: ["pnpm", "test"] } },
    },
  });

  assert.match(prompt, /Repository QA manifest \(trusted controller configuration\)/);
  assert.match(prompt, /example-frontend/);
  assert.match(prompt, /visual preflight/);
  assert.match(prompt, /prove that a small `preflight\.png` can be captured/);
  assert.match(prompt, /excludes preflight-named media from final evidence/);
  assert.match(prompt, /inspect every intended loopback port/);
  assert.match(prompt, /do not stop, remove, or reconfigure that workload/);
  assert.match(prompt, /Select an unused high loopback port/);
  assert.match(prompt, /temporary QA-only override/);
  assert.match(prompt, /keep any port override under the assigned ignored evidence directory/);
  assert.match(prompt, /Compose port lists normally merge additively/);
  assert.match(prompt, /`!override`\/`!reset` mechanism/);
  assert.match(prompt, /inspect `docker compose \.\.\. config`/);
  assert.match(prompt, /merely adding a second mapping does not resolve the conflict/);
  assert.match(prompt, /verify that it belongs to the service you launched/);
  assert.match(prompt, /Docker services run outside the visual sandbox's network namespace/);
  assert.match(prompt, /pi-worker-docker-bridge start <compose-network> <service-name> <container-port>/);
  assert.match(prompt, /socat TCP-LISTEN:<selected-port>/);
  assert.match(prompt, /controller-owned bridge validates and mounts only the current private runtime directory/);
  assert.match(prompt, /direct Docker host mounts, host networking, privileged containers, and socket forwarding remain forbidden/);
  assert.match(prompt, /pi-worker-docker-bridge stop/);
  assert.match(prompt, /use that URL consistently for readiness checks and Playwright/);
  assert.match(prompt, /narrowest checked-in source-backed preview route/);
  assert.match(prompt, /real production components/);
  assert.match(prompt, /A standalone frontend is preferable to a full stack/);
  assert.match(prompt, /Never fabricate an ad-hoc mock page/);
  assert.match(prompt, /component or stylesheet change whose behavior does not depend on CMS values/);
  assert.match(prompt, /imports the exact production component, production configuration, and production styles/);
  assert.match(prompt, /temporary browser-only QA fixture in the running production shell/);
  assert.match(prompt, /loads the exact changed production markup\/component, scripts, configuration, and styles/);
  assert.match(prompt, /never commit it or mutate remote runtime data/);
  assert.match(prompt, /Final evidence must visibly contain the changed production surface/);
  assert.match(prompt, /application-shell screenshot, unrelated route, hidden component/);
  assert.match(prompt, /end with BLOCKED even when the rest of the application launches/);
  assert.match(prompt, /Do not require a backend merely to retrieve interchangeable copy or numbers/);
  assert.match(prompt, /must not duplicate production markup, add preview-only styling, or hard-code the expected geometry/);
  assert.match(prompt, /full repository stack when the changed behavior genuinely requires backend integration/);
  assert.match(prompt, /cannot reach host-loopback services outside the sandbox/);
  assert.match(prompt, /never guess ports from launchSettings/);
  assert.match(prompt, /ASPIRE_CLI_START_TIMEOUT=900/);
  assert.match(prompt, /the timeout is usually a symptom of the real error above it/);
  assert.match(prompt, /aspire describe --apphost <path-to-AppHost\.csproj> --format Json --non-interactive/);
  assert.match(prompt, /identify each required resource by name/);
  assert.match(prompt, /read its current `urls` value from Aspire's runtime state/);
  assert.match(prompt, /instead of inferring ports from environment references/);
  assert.match(prompt, /verify each required endpoint directly before opening the browser/);
  assert.match(prompt, /the API and auth server too, not only the frontend/);
});

// A manifest that declares launch, readiness and auth turns three rediscovered-every-run facts into a
// procedure; the prompt must render each as an instruction, not leave them as JSON for the agent to infer.
test("a manifest with launch, readiness and auth sections renders them as procedures", () => {
  const prompt = buildUiVerificationPrompt({
    config: { appUrl: null, playwrightState: null, sandbox: false } as WorkerConfig,
    issueNumber: 501,
    prNumber: 501,
    evidenceDir: ".qa/issues/501/pr-501/runs/example",
    qaManifest: {
      version: 1,
      aspire: { apphost: "AppHost/AppHost.csproj", resources: { frontend: "app-frontend", api: "app-api" } },
      launch: { argv: ["./scripts/start-apphost.sh"] },
      readiness: { resources: ["api", "frontend"], paths: { api: "/api/abp/application-configuration" } },
      auth: { storageState: "e2e/.auth/qa-state.json", setup: { argv: ["pnpm", "exec", "playwright", "test", "save-auth-state.setup.ts"], envFromEndpoints: { BASE_URL: "frontend" } } },
    },
  });
  assert.match(prompt, /Start the stack with exactly `launch\.argv`/);
  assert.match(prompt, /ready only when every `readiness\.resources` entry has a resolved URL/);
  assert.match(prompt, /playwright-cli -s=<session> state-load <that file>/);
  assert.match(prompt, /Never hand-drive the login form while this is declared/);
  const bare = buildUiVerificationPrompt({
    config: { appUrl: null, playwrightState: null, sandbox: false } as WorkerConfig,
    issueNumber: 501, prNumber: 501, evidenceDir: ".qa/x", qaManifest: { version: 1 },
  });
  assert.doesNotMatch(bare, /launch\.argv|state-load/);
});

// With the OS sandbox off the network-namespace and Docker-bridge guidance would be actively misleading —
// host services ARE reachable and ports ARE shared — so the prompt must swap to the direct-mode facts and,
// above all, stop treating an unstarted backend as a blocker: that single sentence is what blocked PR 501.
test("visual verification without the sandbox tells the agent to start the stack, not to block", () => {
  const prompt = buildUiVerificationPrompt({
    config: { appUrl: null, playwrightState: null, sandbox: false } as WorkerConfig,
    issueNumber: 501,
    prNumber: 501,
    evidenceDir: ".qa/issues/501/pr-501/runs/example",
  });

  assert.match(prompt, /Host-loopback development services .* are reachable directly/);
  assert.match(prompt, /loopback ports are shared with the host and other worker runs/);
  assert.match(prompt, /isolated or parallel-worktree launcher, use it with a run-unique instance name/);
  assert.match(prompt, /A backend that is merely not running is NOT a blocker/);
  assert.match(prompt, /end with BLOCKED only when the launch itself fails, quoting the exact failure/);
  assert.match(prompt, /the controller terminates every background process when a bash call ends/);
  assert.match(prompt, /Direct Docker commands stay policy-gated/);
  // #501 attempt 7: the verifier read "storage state: not configured" as "no credentials" on a fresh instance.
  assert.match(prompt, /Authenticate the way the repository.s own end-to-end tests do/);
  assert.match(prompt, /"No credentials configured" is not a blocker/);
  // Sandbox-only mechanics must be gone, not merely de-emphasised.
  assert.doesNotMatch(prompt, /cannot reach host-loopback services outside the sandbox/);
  assert.doesNotMatch(prompt, /pi-worker-docker-bridge/);
  assert.doesNotMatch(prompt, /network namespace/);
  assert.doesNotMatch(prompt, /private browser sandbox/);
  // Mode-independent guidance stays.
  assert.match(prompt, /inspect every intended loopback port/);
  assert.match(prompt, /aspire describe --apphost/);
  assert.match(prompt, /Never fabricate an ad-hoc mock page/);
});

// With a harness-owned instance the prompt states facts (endpoints, storage state) and prohibitions;
// every launch/port/lifetime procedure that assumed the agent starts the app must be gone.
test("a running instance replaces launch procedures with endpoints, storage state and prohibitions", () => {
  const cfg = { appUrl: null, playwrightState: null, sandbox: false } as WorkerConfig;
  const qaManifest = { version: 1 as const, launch: { argv: ["./run.sh"] }, readiness: { paths: { frontend: "/en" } }, auth: { storageState: "e2e/.auth/state.json" } };
  const instance = { endpoints: { frontend: "http://localhost:3005", api: "https://localhost:44431" }, storageState: "/data/instances/issue-1/r/storage-state.json", readinessMs: 82_000 };
  const text = buildUiVerificationPrompt({ config: cfg, issueNumber: 1, prNumber: null, evidenceDir: ".qa/issues/1/runs/x", qaManifest, instance });
  for (const rule of [
    /already running for this run/, /frontend `http:\/\/localhost:3005`/, /api `https:\/\/localhost:44431`/, /ready after 82 s/,
    /state-load \/data\/instances\/issue-1\/r\/storage-state\.json/, /Do not start, stop or relaunch/, /do not use `setsid`/,
    /Do not run the repository's Playwright e2e or post-deploy suites/, /playwright-cli open\/interact\/capture\/close sequence in one bash tool call/,
    /preflight\.png/,
  ]) assert.match(text, rule);
  for (const gone of [
    /Start the stack with exactly/, /ASPIRE_CLI_START_TIMEOUT/, /inspect every intended loopback port/,
    /the controller terminates every background process/, /A backend that is merely not running is NOT a blocker/,
    /Optional protected Playwright storage state/, /Authenticate the way the repository.s own end-to-end tests do/,
  ]) assert.doesNotMatch(text, gone);
});

test("prompts render the project memory index and the saving rules", () => {
  const cfg = { appUrl: null, playwrightState: null, sandbox: false } as WorkerConfig;
  const memory = { dir: "/data/memory", text: "- launcher-timing.md — Launcher takes ~80 s warm\n  Aspire reports Running after 18 s.\n", skipped: [] };
  const issue: GitHubIssue = {
    number: 1, title: "Add a thing", body: "Do it", url: "https://example.test/issues/1", updatedAt: "2026-09-14T00:00:00Z", labels: [], author: { login: "maintainer" },
  };
  const text = buildIssuePrompt({ config: cfg, issue, evidenceDir: null, memory });
  assert.match(text, /Project memory — notes from earlier runs; advisory, verify before relying on them\. Directory: \/data\/memory/);
  assert.match(text, /launcher-timing\.md — Launcher takes ~80 s warm/);
  assert.match(text, /one durable fact per file/);
  assert.match(text, /never secrets/i);
  assert.doesNotMatch(buildIssuePrompt({ config: cfg, issue, evidenceDir: null }), /Project memory/);
  assert.match(buildUiVerificationPrompt({ config: cfg, issueNumber: 1, prNumber: null, evidenceDir: ".qa/x", memory }), /Project memory/);
});
