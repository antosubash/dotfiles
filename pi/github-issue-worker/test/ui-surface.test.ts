import assert from "node:assert/strict";
import test from "node:test";
import { diffTouchesUi, isUiSurface } from "../src/ui-surface.js";

test("UI surface is detected from issue text or changed paths", () => {
  const issue = { title: "Speed up import", body: "Batch the inserts" };
  assert.equal(isUiSurface(issue, "src/import/batch.ts\n", ""), false);
  assert.equal(isUiSurface(issue, "frontend/apps/web/src/routes/admin.tsx\n", ""), true);
  assert.equal(isUiSurface({ title: "Fix the settings dialog", body: "" }, "", ""), true);
  assert.equal(isUiSurface(issue, "", "app/pages/new.vue\n"), true);
});

test("only changed paths make the UI evidence gate mandatory, never issue prose", () => {
  // Backend fix whose report mentions "the public article page": a browser may be offered, screenshots are not required.
  const issue = { title: "Reject hostless URLs", body: "The public article page then emits it as the canonical link." };
  assert.equal(isUiSurface(issue, "modules/news/news/safe_url.py\n", ""), true);
  assert.equal(diffTouchesUi("modules/news/news/safe_url.py\nmodules/news/tests/test_safe_url.py\n", ""), false);
  assert.equal(diffTouchesUi("modules/pagebuilder/pagebuilder/components/editor/Toolbar.tsx\n", ""), true);
  assert.equal(diffTouchesUi("", "app/pages/new.vue\n"), true);
  assert.equal(diffTouchesUi("src/templates/email.html\n", ""), true);
});
