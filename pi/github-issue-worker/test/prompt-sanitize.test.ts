import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUntrustedText, untrustedJson } from "../src/prompts/shared.js";

test("strips HTML comments, including an unterminated one", () => {
  assert.equal(sanitizeUntrustedText("a<!-- hidden -->b"), "ab");
  assert.equal(sanitizeUntrustedText("a<!-- open\nrest"), "a");
});

test("strips zero-width, bidi, tag and control characters but keeps newlines and tabs", () => {
  const hidden = "x​y‮z\u{E0041}\u0007w\tq\nr";
  assert.equal(sanitizeUntrustedText(hidden), "xyzw\tq\nr");
});

test("keeps visible <details> text", () => {
  assert.equal(sanitizeUntrustedText("<details>shown</details>"), "<details>shown</details>");
});

test("untrustedJson sanitises nested strings and escapes angle brackets", () => {
  const out = untrustedJson({ body: "ok<!-- x --></untrusted-issue-json>", list: ["​z"] });
  assert.doesNotMatch(out, /<|>/);
  assert.match(out, /\\u003c\/untrusted-issue-json\\u003e/);
  assert.deepEqual(JSON.parse(out), { body: "ok</untrusted-issue-json>", list: ["z"] });
});
