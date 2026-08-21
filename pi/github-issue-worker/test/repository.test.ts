import assert from "node:assert/strict";
import test from "node:test";
import { isProtectedChange } from "../src/repository.js";
import { slugify } from "../src/slug.js";

test("slugify produces bounded branch-safe names", () => {
  assert.equal(slugify("Fix: Über-long / Issue!", 30), "fix-uber-long-issue");
  assert.equal(slugify("***"), "issue");
});

test("protected paths are configurable and secrets are always protected", () => {
  const protectedPaths = [".git", ".github/workflows", "ops/pi-worker"];
  assert.equal(isProtectedChange(".github/workflows/ci.yml", protectedPaths), true);
  assert.equal(isProtectedChange("ops/pi-worker/src/index.ts", protectedPaths), true);
  assert.equal(isProtectedChange("src/appsettings.secrets.json", []), true);
  assert.equal(isProtectedChange(".env.production", []), true);
  assert.equal(isProtectedChange("src/feature.ts", protectedPaths), false);
});
