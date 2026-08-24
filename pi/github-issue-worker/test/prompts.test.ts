import assert from "node:assert/strict";
import test from "node:test";
import { buildUiVerificationPrompt } from "../src/prompts.js";
import type { WorkerConfig } from "../src/config.js";

test("visual verification prefers truthful source-backed previews over unrelated full stacks", () => {
  const prompt = buildUiVerificationPrompt({
    config: { appUrl: null, playwrightState: null } as WorkerConfig,
    issueNumber: 548,
    prNumber: null,
    evidenceDir: ".qa/issues/548/pr-pending/runs/example",
  });

  assert.match(prompt, /narrowest checked-in source-backed preview route/);
  assert.match(prompt, /real production components/);
  assert.match(prompt, /A standalone frontend is preferable to a full stack/);
  assert.match(prompt, /Never fabricate an ad-hoc mock page/);
  assert.match(prompt, /full repository stack when the changed behavior genuinely requires backend integration/);
  assert.match(prompt, /cannot reach host-loopback services outside the sandbox/);
});
