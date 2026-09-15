import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerConfig } from "../src/config.js";
import type { QaManifest } from "../src/qa-manifest.js";
import { buildFeedbackPrompt, buildIssuePrompt, buildUiVerificationPrompt } from "../src/prompts.js";

const config = { appUrl: null, playwrightState: null, sandbox: false } as WorkerConfig;
const manifest: QaManifest = {
  version: 1,
  launch: { argv: ["./scripts/start-app.sh"] },
  readiness: { endpoints: { frontend: "http://127.0.0.1:18086" } },
};
const issue = {
  number: 28, title: "Test module", body: "A press me button shows hello tina",
  url: "https://example.test/issues/28", updatedAt: "2026-09-15T00:00:00Z",
  labels: [], author: { login: "maintainer" },
};

function prompts(qaManifest: QaManifest | null, evidenceDir: string | null): string[] {
  return [
    buildIssuePrompt({ config, issue, qaManifest, evidenceDir }),
    buildFeedbackPrompt({
      config, issueNumber: 28, prNumber: 29, qaManifest, evidenceDir,
      feedback: [], gifRequested: true,
    }),
  ];
}

test("shared-app preparation defers browser checks without waiving the later gates", () => {
  for (const prompt of prompts(manifest, null)) {
    assert.match(prompt, /controller has NOT started the QA application yet/);
    assert.match(prompt, /including verification-only feedback/);
    assert.match(prompt, /without changing tracked files/);
    assert.match(prompt, /Do not launch the application, look for a controller endpoint, guess ports/);
    assert.match(prompt, /Do not return BLOCKED solely because no running application/);
    assert.match(prompt, /pending the controller's next stage, never as passed or waived/);
    assert.match(prompt, /genuine source\/test failures, and other real blockers must still be reported/);
    assert.match(prompt, /visual and independent QA gates remain mandatory/);
    assert.doesNotMatch(prompt, /Before editing UI code, perform a visual preflight/);
  }
});

test("ordinary no-launch preparation does not promise a controller-owned application", () => {
  for (const qaManifest of [null, { version: 1 } as const]) {
    for (const prompt of prompts(qaManifest, null)) {
      assert.doesNotMatch(prompt, /Controller-owned application lifecycle|controller has NOT started/);
    }
  }
});

test("assigned browser work still requires fresh evidence and real blocker reporting", () => {
  for (const prompt of prompts(manifest, ".qa/current")) {
    assert.doesNotMatch(prompt, /controller has NOT started/);
    assert.match(prompt, /Before editing UI code, perform a visual preflight/);
    assert.match(prompt, /Final evidence must visibly contain the changed production surface/);
  }
  const prompt = buildUiVerificationPrompt({
    config, issueNumber: 28, prNumber: 29, evidenceDir: ".qa/current", qaManifest: manifest,
    instance: { endpoints: { frontend: "http://127.0.0.1:18086" }, storageState: null, readinessMs: 7000 },
  });
  assert.doesNotMatch(prompt, /controller has NOT started/);
  assert.match(prompt, /application is already running/);
  assert.match(prompt, /End with BLOCKED if the app cannot be/);
});
