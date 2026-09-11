import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { execFile } from "../src/exec.js";
import type { PiAgentRunner } from "../src/pi-agent.js";
import { DEFAULT_QA_CHECKS, QaVerificationService, assertQaExecution, validateQaResult, verifierSourcePolicy } from "../src/qa-verification.js";
import type { GitHubIssue, VerificationEvidence } from "../src/types.js";

// Shapes taken from iiasa/IIASA.GeoWiki#555: the runner recorded a multi-line
// script with an exit-status wrapper; the verdict JSON echoed the core command
// with `; ` separators and no wrapper. QA had passed; the gate rejected it.
const evidenceDir = "/data/verification/issue-555/run/evidence";
const core = `TMPDIR="$EVIDENCE/tmp" pnpm --dir frontend --filter @geowiki/pagebuilder exec vitest run src/widgets/__tests__/badge.test.tsx --cache=false > "$EVIDENCE/widget-test-runner.log" 2>&1`;
const recorded = `EVIDENCE=${evidenceDir}\n${core}\nstatus=$?\nprintf 'exit=%s\\n' "$status"`;
const claimed = `EVIDENCE=${evidenceDir}; ${core}`;

function verdict(...commands: string[]) {
  return { commands: commands.map((command) => ({ command, status: "passed", log: "widget-test-runner.log" })) };
}

function runnerRecorded(...commands: string[]): VerificationEvidence {
  return { commands: commands.map((command) => ({ command, output: "ok" })), readPaths: [] };
}

test("command receipts tolerate newline-vs-semicolon and wrapper lines around the claimed command", () => {
  assertQaExecution(verdict(claimed), runnerRecorded(recorded));
  assertQaExecution(verdict(core), runnerRecorded(recorded));
  assertQaExecution(verdict(`  ${core.replace(/ +/g, "   ")}  `), runnerRecorded(recorded));
});

test("command receipts still accept an exact echo of the recorded command", () => {
  assertQaExecution(verdict(recorded), runnerRecorded(recorded));
});

test("command receipts reject commands that were never recorded or that add to what ran", () => {
  assert.throws(() => assertQaExecution(verdict("pnpm test"), runnerRecorded(recorded)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict(`${core} --coverage`), runnerRecorded(recorded)), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict(claimed), undefined), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict(claimed, "git diff --check"), runnerRecorded(recorded)), /runner-recorded/);
});

// The Pi bash tool throws on a non-zero exit, so a recorded command is one that exited 0. A claim may
// therefore drop only trailing exit-status bookkeeping; dropping a trailing command that could itself
// have produced the zero exit (`; true`) would let a failing check be claimed as a bare passing one.
test("a claim may drop trailing exit-status bookkeeping but not a trailing command", () => {
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\nprintf 'exit=%s\\n' "$status"`));
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test; true")), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test; :")), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test; npm run lint")), /runner-recorded/);
});

// A trailing `echo`/`printf` is only bookkeeping when it actually reports the exit status. Bare text —
// or a variable never captured from `$?` — always succeeds regardless of what ran before it, exactly
// like `true`, so it must not be droppable: `npm test; echo done` must not read as a bare passing
// `npm test` just because the trailing statement happens to start with `echo`.
test("a trailing echo/printf must reference the exit status to count as bookkeeping", () => {
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded("npm test; echo done")), /runner-recorded/);
  assert.throws(() => assertQaExecution(verdict("npm test"), runnerRecorded(`npm test; printf 'done\\n'`)), /runner-recorded/);
  assert.throws(
    () => assertQaExecution(verdict("npm test"), runnerRecorded("npm test\nstatus=$?\necho unrelated")),
    /runner-recorded/,
  );
  assertQaExecution(verdict("npm test"), runnerRecorded("npm test; echo $?"));
  assertQaExecution(verdict("npm test"), runnerRecorded(`npm test\nstatus=$?\necho "$status"`));
});

// A claimed command must match a whole recorded statement, not just any contiguous slice of text: a
// name like `npm test` is a plain prefix of the unrelated `npm test:unit --silent`, and matching a
// partial word would let a verifier claim a command it never ran.
test("command receipts reject a claim that is only a partial-word match of an unrelated recorded command", () => {
  assert.throws(
    () => assertQaExecution(verdict("npm test"), runnerRecorded("npm test:unit --silent")),
    /runner-recorded/,
  );
  assert.throws(
    () => assertQaExecution(verdict("pnpm lint"), runnerRecorded("pnpm lint:fix --quiet")),
    /runner-recorded/,
  );
});

const qaChecks = DEFAULT_QA_CHECKS.map((id) => ({ id, status: "passed", notes: "observed" }));

function passedVerdict(log: unknown) {
  return JSON.stringify({ status: "passed", surface: "non-ui", summary: "ok", checks: qaChecks,
    commands: [{ command: "pnpm test", status: "passed", log }], screenshots: [] });
}

async function evidenceFixture(...logs: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-qa-logs-"));
  for (const name of logs) await writeFile(join(dir, name), "output\n");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Shape taken from iiasa/IIASA.GeoWiki#557: one command entry named two logs
// joined by `;`. Both files existed; the gate raised a raw ENOENT.
test("a command may name several log files as an array or a ;-joined string", async () => {
  const f = await evidenceFixture("mowing-test.log", "pagebuilder-test.log");
  try {
    await validateQaResult(passedVerdict(["mowing-test.log", "pagebuilder-test.log"]), DEFAULT_QA_CHECKS, f.dir, false);
    await validateQaResult(passedVerdict("mowing-test.log;pagebuilder-test.log"), DEFAULT_QA_CHECKS, f.dir, false);
    await validateQaResult(passedVerdict("mowing-test.log"), DEFAULT_QA_CHECKS, f.dir, false);
  } finally { await f.cleanup(); }
});

test("a missing or empty log list is reported by name instead of a raw filesystem error", async () => {
  const f = await evidenceFixture("present.log");
  try {
    await assert.rejects(validateQaResult(passedVerdict("absent.log"), DEFAULT_QA_CHECKS, f.dir, false),
      (error: Error) => /QA command log.*absent\.log/.test(error.message) && !/ENOENT/.test(error.message));
    await assert.rejects(validateQaResult(passedVerdict([]), DEFAULT_QA_CHECKS, f.dir, false), /omitted validation command outcomes\/logs/);
    await assert.rejects(validateQaResult(passedVerdict(7), DEFAULT_QA_CHECKS, f.dir, false), /omitted validation command outcomes\/logs/);
  } finally { await f.cleanup(); }
});

// --- screenshot evidence is never repair-eligible ----------------------------

function uiVerdict(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ status: "passed", surface: "ui", summary: "ok", checks: qaChecks,
    commands: [{ command: "pnpm test", status: "passed", log: "checks.log" }], screenshots: ["desktop.png", "mobile.png"], ...overrides });
}

test("a verdict claiming the same screenshot twice is a terminal error, not repair-eligible", async () => {
  const f = await evidenceFixture("desktop.png", "checks.log");
  try {
    await assert.rejects(
      validateQaResult(uiVerdict({ screenshots: ["desktop.png", "desktop.png"] }), DEFAULT_QA_CHECKS, f.dir, true),
      (error: Error) => /distinct desktop and mobile screenshots/.test(error.message) && error.constructor.name === "Error",
    );
  } finally { await f.cleanup(); }
});

test("fewer than two screenshots is a terminal error, not repair-eligible", async () => {
  const f = await evidenceFixture("desktop.png", "checks.log");
  try {
    await assert.rejects(
      validateQaResult(uiVerdict({ screenshots: ["desktop.png"] }), DEFAULT_QA_CHECKS, f.dir, true),
      (error: Error) => /distinct desktop and mobile screenshots/.test(error.message) && error.constructor.name === "Error",
    );
  } finally { await f.cleanup(); }
});

// --- bounded repair turn -----------------------------------------------------

const issue: GitHubIssue = { number: 42, title: "Add behavior", body: "Return the required result.", url: "https://github.com/example/repo/issues/42", updatedAt: "now", labels: [], author: { login: "owner" } };

async function worktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-qa-repair-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const git = (args: string[]) => execFile("git", args, { cwd: worktree });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await writeFile(join(worktree, "source.txt"), "initial\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const config = loadConfig({ HOME: root, PI_WORKER_REPOSITORY: "example/repo", PI_WORKER_BASE_BRANCH: "main", PI_WORKER_DATA_DIR: join(root, "data") });
  return { root, worktree, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function verdictJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ status: "passed", surface: "non-ui", summary: "ok", checks: qaChecks,
    commands: [{ command: "pnpm test", status: "passed", log: "checks.log" }], screenshots: [], ...overrides });
}

/** Scripted verifier: each entry is one agent turn's final text plus the commands the runner recorded during it. */
function scriptedAgent(turns: Array<{ finalText: string; recorded?: string[]; mutate?: (evidenceDir: string) => Promise<void> }>) {
  const calls: Array<{ sessionFile: string | null; prompt: string }> = [];
  const agent: Pick<PiAgentRunner, "run"> = { run: async (options) => {
    const turn = turns[calls.length];
    if (!turn) throw new Error(`unexpected agent turn ${calls.length + 1}`);
    calls.push({ sessionFile: options.sessionFile, prompt: options.prompt });
    // Only the first turn writes evidence: a compliant repair turn re-emits JSON and changes nothing on disk.
    if (calls.length === 1) await writeFile(join(options.verification!.evidenceDir, "checks.log"), "test output\n");
    if (turn.mutate) await turn.mutate(options.verification!.evidenceDir);
    return { sessionFile: join(options.sessionDir, "qa.jsonl"), finalText: turn.finalText,
      verificationEvidence: { commands: (turn.recorded ?? []).map((command) => ({ command, output: "ok" })), readPaths: [] } };
  } };
  return { agent, calls };
}

test("a malformed passing verdict gets one repair turn in the same session and then passes", async () => {
  const f = await worktreeFixture();
  try {
    const { agent, calls } = scriptedAgent([
      { finalText: verdictJson({ commands: [{ command: "pnpm test --coverage", status: "passed", log: "checks.log" }] }), recorded: ["pnpm test"] },
      { finalText: verdictJson() },
    ]);
    const report = await new QaVerificationService(f.config, agent).verify(issue, f.worktree, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.sessionFile, null);
    assert.equal(calls[1]!.sessionFile, join(f.config.dataDir, "verification", "issue-42", report.split("/").at(-2)!, "sessions", "qa.jsonl"));
    assert.match(calls[1]!.prompt, /reporting problem/i);
    assert.match(calls[1]!.prompt, /runner-recorded/);
    assert.doesNotMatch(calls[1]!.prompt, /NOT the implementation worker/);
    const saved = JSON.parse(await readFile(report, "utf8"));
    assert.equal(saved.status, "passed");
    assert.deepEqual(saved.execution.commands.map((entry: { command: string }) => entry.command), ["pnpm test"]);
  } finally { await f.cleanup(); }
});

test("a failed or blocked verdict is never sent back for repair", async () => {
  const f = await worktreeFixture();
  try {
    for (const status of ["failed", "blocked"]) {
      const { agent, calls } = scriptedAgent([{ finalText: verdictJson({ status, summary: `QA ${status}` }), recorded: ["pnpm test"] }]);
      await assert.rejects(new QaVerificationService(f.config, agent).verify(issue, f.worktree, null), status === "failed" ? /FAILED/ : /BLOCKED/);
      assert.equal(calls.length, 1);
    }
  } finally { await f.cleanup(); }
});

test("a verdict that is still malformed after the repair turn blocks", async () => {
  const f = await worktreeFixture();
  try {
    const bad = verdictJson({ commands: [{ command: "pnpm lint", status: "passed", log: "checks.log" }] });
    const { agent, calls } = scriptedAgent([{ finalText: bad, recorded: ["pnpm test"] }, { finalText: bad }]);
    await assert.rejects(new QaVerificationService(f.config, agent).verify(issue, f.worktree, null), /runner-recorded/);
    assert.equal(calls.length, 2);
  } finally { await f.cleanup(); }
});

test("the repair turn cannot add evidence: only the original run's receipts count", async () => {
  const f = await worktreeFixture();
  try {
    const claimsLint = verdictJson({ commands: [{ command: "pnpm lint", status: "passed", log: "checks.log" }] });
    const { agent, calls } = scriptedAgent([{ finalText: claimsLint, recorded: ["pnpm test"] }, { finalText: claimsLint, recorded: ["pnpm lint"] }]);
    await assert.rejects(new QaVerificationService(f.config, agent).verify(issue, f.worktree, null), /runner-recorded/);
    assert.equal(calls.length, 2);
  } finally { await f.cleanup(); }
});

test("a repair turn that changes evidence is rejected without a further repair", async () => {
  const f = await worktreeFixture();
  try {
    const malformed = verdictJson({ commands: [{ command: "pnpm test --coverage", status: "passed", log: "checks.log" }] });
    const corrected = verdictJson();
    const { agent, calls } = scriptedAgent([
      { finalText: malformed, recorded: ["pnpm test"] },
      { finalText: corrected, recorded: ["pnpm test"], mutate: (evidenceDir) => writeFile(join(evidenceDir, "checks.log"), "tampered\n") },
    ]);
    await assert.rejects(new QaVerificationService(f.config, agent).verify(issue, f.worktree, null), (error: Error) => {
      assert.match(error.message, /repair turn changed evidence/);
      assert.doesNotMatch(error.message, /runner-recorded/);
      return true;
    });
    assert.equal(calls.length, 2);
  } finally { await f.cleanup(); }
});

// A verdict is a statement about one exact tree (the source fingerprint covers HEAD, index, tracked and
// untracked content). When the same tree comes back — a GitHub outage after a pass, an interrupted push —
// re-running a 45-minute verification adds nothing; the passed report is the answer. Anything that changes
// the tree changes the fingerprint and gets a fresh run.
test("a passed verdict is reused for an identical source fingerprint and never across a change", async () => {
  const f = await worktreeFixture();
  try {
    const { agent, calls } = scriptedAgent([{ finalText: verdictJson(), recorded: ["pnpm test"] }, { finalText: verdictJson(), recorded: ["pnpm test"] }]);
    const service = new QaVerificationService(f.config, agent);
    const first = await service.verify(issue, f.worktree, null);
    assert.equal(await service.verify(issue, f.worktree, null), first);
    assert.equal(calls.length, 1);
    // The scripted second turn is deliberately incomplete; what matters is that a changed tree runs again.
    await writeFile(join(f.worktree, "source.txt"), "changed\n");
    await service.verify(issue, f.worktree, null).catch(() => undefined);
    assert.equal(calls.length, 2);
  } finally { await f.cleanup(); }
});

// The verifier's prompt must describe the guard that is actually in force. Claiming an OS-read-only source
// when there is none would send the verifier redirecting every build output for no reason — and, worse,
// still reporting BLOCKED for a backend it is now perfectly able to start.
test("the verifier prompt describes fingerprinting, not a read-only mount, when the sandbox is off", async () => {
  assert.match(verifierSourcePolicy({ sandbox: true }), /OS-read-only/);
  assert.match(verifierSourcePolicy({ sandbox: false }), /fingerprinted before and after/);
  assert.match(verifierSourcePolicy({ sandbox: false }), /normal ignored locations/);
  assert.doesNotMatch(verifierSourcePolicy({ sandbox: false }), /OS-read-only/);
  const f = await worktreeFixture();
  try {
    const { agent, calls } = scriptedAgent([{ finalText: verdictJson(), recorded: ["pnpm test"] }]);
    await new QaVerificationService({ ...f.config, sandbox: false }, agent).verify(issue, f.worktree, null);
    assert.match(calls[0]!.prompt, /merely not running is not an unavailable dependency/);
    assert.match(calls[0]!.prompt, /report blocked only with the exact launch failure/);
    // Attempt 5 on #501: the verifier built with --no-restore and a stale node_modules after a base merge and
    // reported 44 missing-assets errors as a code failure. Restore first; untouched-file failures are notes.
    assert.match(calls[0]!.prompt, /Restore and install dependencies first, exactly as the repository's CI does/);
    assert.match(calls[0]!.prompt, /Never pass `--no-restore`\/`--no-build` unless this session restored\/built that exact project/);
    assert.match(calls[0]!.prompt, /fails only in files the task diff does not touch, after a fresh restore\/install, is a\npre-existing base-branch condition/);
    // Attempt 8: Biome tripped on the Playwright auth state the verifier's own e2e run had just written.
    assert.match(calls[0]!.prompt, /A file\nyour own run created .* is never a code failure/);
    assert.doesNotMatch(calls[0]!.prompt, /OS-read-only/);
  } finally { await f.cleanup(); }
});
