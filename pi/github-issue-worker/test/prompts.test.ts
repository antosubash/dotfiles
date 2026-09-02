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
    config: { appUrl: null, playwrightState: null } as WorkerConfig,
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
  assert.match(prompt, /aspire describe --apphost <path-to-AppHost\.csproj> --format Json --non-interactive/);
  assert.match(prompt, /identify each required resource by name/);
  assert.match(prompt, /read its current `urls` value from Aspire's runtime state/);
  assert.match(prompt, /instead of inferring ports from environment references/);
  assert.match(prompt, /verify each required endpoint directly before opening the browser/);
});
