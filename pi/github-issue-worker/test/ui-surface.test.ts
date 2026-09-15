import assert from "node:assert/strict";
import test from "node:test";
import { isUiSurface } from "../src/ui-surface.js";

test("UI surface is detected from issue text or changed paths", () => {
  const issue = { title: "Speed up import", body: "Batch the inserts" };
  assert.equal(isUiSurface(issue, "src/import/batch.ts\n", ""), false);
  assert.equal(isUiSurface(issue, "frontend/apps/web/src/routes/admin.tsx\n", ""), true);
  assert.equal(isUiSurface({ title: "Fix the settings dialog", body: "" }, "", ""), true);
  assert.equal(isUiSurface(issue, "", "app/pages/new.vue\n"), true);
});
