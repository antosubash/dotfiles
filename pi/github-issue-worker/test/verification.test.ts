import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { execFile } from "../src/exec.js";
import { DESIGN_CHECKS, FigmaVerificationService, figmaTargets, sourceFingerprint, validateDesignResult, type FigmaReference } from "../src/figma-verification.js";
import { IssuePlanService, issueHash, validatePlan, type IssuePlan } from "../src/issue-plan.js";
import { QaVerificationService, DEFAULT_QA_CHECKS, validateQaResult, assertQaExecution } from "../src/qa-verification.js";
import { sandboxConfig, type PiAgentRunner } from "../src/pi-agent.js";
import type { GitHubIssue } from "../src/types.js";

const issue: GitHubIssue = { number: 42, title: "Add behavior", body: "Return the required result and reject invalid input.", url: "https://github.com/example/repo/issues/42", updatedAt: "now", labels: [], author: { login: "owner" } };
const target = figmaTargets("figma.com/design/AbC/Frame?node-id=1-2")[0]!;
// Tiny PNG fixture (not live browser evidence).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const referencePng = Buffer.concat([png, Buffer.from("reference-fixture")]);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-independent-qa-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const git = (args: string[]) => execFile("git", args, { cwd: worktree });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await writeFile(join(worktree, "source.txt"), "initial\n");
  await writeFile(join(worktree, ".gitignore"), "ignored\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const config = loadConfig({ HOME: root, PI_WORKER_REPOSITORY: "example/repo", PI_WORKER_BASE_BRANCH: "main", PI_WORKER_DATA_DIR: join(root, "data") });
  return { root, worktree, config, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function planned(source: string): IssuePlan {
  return { schemaVersion: 1, issueNumber: 42, issueHash: issueHash(issue), sourceFingerprint: source,
    implementationSteps: ["Implement and test behavior"],
    checks: [{ id: "P1", kind: "behavioral", requirement: "Returns result", steps: ["Run the behavior test"], expected: "Correct result" }] };
}

function qaVerdict(ids = DEFAULT_QA_CHECKS) {
  return { status: "passed", surface: "non-ui", summary: "Behavior verified",
    checks: ids.map((id) => ({ id, status: "passed", notes: "Observed expected result in targeted test" })),
    commands: [{ command: "test-command", status: "passed", log: "checks.log" }], screenshots: [] as string[] };
}

function designVerdict(reference: FigmaReference) {
  return { status: "passed", summary: "Compared frame", frames: [{ url: reference.url, version: reference.version, status: "passed",
    appUrl: "http://localhost:9876/feature", viewport: { width: 1, height: 1 }, screenshots: ["frame.png"],
    checks: Object.fromEntries(DESIGN_CHECKS.map((check) => [check, { status: "passed", notes: "Expected vs actual observation" }])) }] };
}

test("Figma detection normalizes Markdown/bare/branch/encoded links and deduplicates tracking", () => {
  assert.deepEqual(figmaTargets("[frame](https://www.figma.com/file/AbC/Test?node-id=1%3A2&t=x) figma.com/design/AbC?node-id=1-2"), [target]);
  assert.equal(figmaTargets("<https://figma.com/design/Main/branch/Branch/Test?node-id=3-4>")[0]?.fileKey, "Branch");
  assert.equal(figmaTargets("FIGMA.COM/design/AbC?node-id=1-2&amp;t=ignored")[0]?.nodeId, "1:2");
  assert.deepEqual(figmaTargets("https://figma.com.evil/design/AbC?node-id=1-2 https://evil.example/figma.com/design/AbC?node-id=1-2"), []);
  assert.deepEqual(figmaTargets(issue.body), []);
  for (const text of ["https://figma.com/design/AbC", "figma.com/make/AbC?node-id=1-2", "http://figma.com/design/AbC?node-id=1-2", "https://figma.com:bad/design/AbC?node-id=1-2", "https://u@figma.com/design/AbC?node-id=1-2"]) assert.throws(() => figmaTargets(text), /BLOCKED/);
  assert.throws(() => figmaTargets(Array.from({ length: 11 }, (_, n) => `figma.com/design/K?node-id=1-${n}`).join(" ")), /at most 10/);
});

test("fingerprint detects dirty, staged, deleted and untracked source but ignores runtime output", async () => {
  const f = await fixture();
  try {
    const initial = await sourceFingerprint(f.worktree);
    await writeFile(join(f.worktree, "ignored"), "runtime");
    assert.equal(await sourceFingerprint(f.worktree), initial);
    await writeFile(join(f.worktree, "source.txt"), "changed");
    const dirty = await sourceFingerprint(f.worktree);
    assert.notEqual(dirty, initial);
    await f.git(["add", "source.txt"]);
    assert.notEqual(await sourceFingerprint(f.worktree), dirty);
    await writeFile(join(f.worktree, "new.txt"), "new");
    const added = await sourceFingerprint(f.worktree);
    await writeFile(join(f.worktree, "new.txt"), "different");
    assert.notEqual(await sourceFingerprint(f.worktree), added);
    await rm(join(f.worktree, "source.txt"));
    assert.notEqual(await sourceFingerprint(f.worktree), initial);
  } finally { await f.cleanup(); }
});

test("ordinary QA needs explicit complete checks and real log files, not implementation prose", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "evidence"); await mkdir(dir);
    await writeFile(join(dir, "checks.log"), "test output: passed");
    const result = qaVerdict();
    assert.throws(() => assertQaExecution(result, undefined), /runner-recorded/);
    assert.throws(() => assertQaExecution(result, { commands: [{ command: "other-command", output: "success" }], readPaths: [] }), /runner-recorded/);
    await validateQaResult(JSON.stringify(result), DEFAULT_QA_CHECKS, dir, false);
    await assert.rejects(validateQaResult("Implemented and tested", DEFAULT_QA_CHECKS, dir, false));
    await assert.rejects(validateQaResult(JSON.stringify({ ...result, checks: [] }), DEFAULT_QA_CHECKS, dir, false), /BLOCKED/);
    await assert.rejects(validateQaResult(JSON.stringify(result), [...DEFAULT_QA_CHECKS, "P1"], dir, false), /BLOCKED/);
    await assert.rejects(validateQaResult(JSON.stringify(result), DEFAULT_QA_CHECKS, dir, true), /desktop and mobile/);
    await rm(join(dir, "checks.log"));
    await symlink(join(f.worktree, "source.txt"), join(dir, "checks.log"));
    await assert.rejects(validateQaResult(JSON.stringify(result), DEFAULT_QA_CHECKS, dir, false), /symlinks/);
  } finally { await f.cleanup(); }
});

test("QA is a fresh independent run and follows optional plan checks; source mutations block", async () => {
  const f = await fixture();
  let mutate = false;
  let count = 0;
  try {
    const plan = planned(await sourceFingerprint(f.worktree));
    const agent: Pick<PiAgentRunner, "run"> = { run: async (options) => {
      count++;
      assert.equal(options.sessionFile, null);
      assert.ok(options.verification);
      assert.equal(options.planning, undefined);
      assert.match(options.prompt, /NOT the implementation worker/);
      assert.match(options.prompt, count === 1 ? /No pi-plan was requested/ : /Follow each saved plan check/);
      await writeFile(join(options.verification!.evidenceDir, "checks.log"), "actual test output");
      if (mutate) await writeFile(join(f.worktree, "source.txt"), "verifier must not fix source");
      return { sessionFile: join(options.sessionDir, "qa.jsonl"), finalText: JSON.stringify(qaVerdict(count === 1 ? DEFAULT_QA_CHECKS : [...DEFAULT_QA_CHECKS, "P1"])),
        verificationEvidence: { commands: [{ command: "test-command", output: "actual test output" }], readPaths: [] } };
    } };
    const service = new QaVerificationService(f.config, agent);
    const report = await service.verify(issue, f.worktree, null);
    assert.equal(JSON.parse(await readFile(report, "utf8")).status, "passed");
    await service.verify(issue, f.worktree, plan);
    mutate = true;
    await assert.rejects(service.verify(issue, f.worktree, plan), /changed source/);
  } finally { await f.cleanup(); }
});

test("pi-plan is plan-only, persists valid checklist, and refuses stale requirements", async () => {
  const f = await fixture();
  try {
    const agent: Pick<PiAgentRunner, "run"> = { run: async (options) => {
      assert.equal(options.planning, true);
      assert.equal(options.sessionFile, null);
      assert.equal(options.dockerAccess, undefined);
      assert.match(options.prompt, /plan ONLY/);
      const plan = planned(await sourceFingerprint(f.worktree));
      return { sessionFile: join(options.sessionDir, "plan.jsonl"), finalText: JSON.stringify(plan) };
    } };
    const service = new IssuePlanService(f.config, agent);
    assert.equal(await service.load(issue), null);
    const initial = await sourceFingerprint(f.worktree);
    const plan = await service.create(issue, f.worktree);
    assert.equal(await sourceFingerprint(f.worktree), initial);
    assert.deepEqual(await service.load(issue), plan);
    await assert.rejects(service.load({ ...issue, body: "Changed requirements" }), /stale/);
    assert.throws(() => validatePlan({ ...plan, checks: [] }), /incomplete/);
    assert.throws(() => validatePlan({ ...plan, checks: [plan.checks[0], plan.checks[0]] }), /incomplete/);
  } finally { await f.cleanup(); }
});

test("design verdict requires every frame/version/comparison, fresh PNG, and plan check", async () => {
  const f = await fixture();
  try {
    const evidence = join(f.root, "evidence"); const directory = join(f.root, "reference");
    await mkdir(evidence); await mkdir(directory);
    await writeFile(join(evidence, "frame.png"), png); await writeFile(join(directory, "reference.png"), referencePng);
    const reference: FigmaReference = { ...target, directory, version: "v1" };
    const result = designVerdict(reference);
    await validateDesignResult(JSON.stringify(result), [reference], evidence);
    await assert.rejects(validateDesignResult(JSON.stringify(result), [reference, { ...reference, url: "other" }], evidence), /coverage/);
    await assert.rejects(validateDesignResult(JSON.stringify(result), [{ ...reference, version: "v2" }], evidence), /identity/);
    await assert.rejects(validateDesignResult(JSON.stringify(result), [reference], evidence, ["P2"]), /pi-plan/);
    result.frames[0]!.checks.layout!.status = "failed";
    await assert.rejects(validateDesignResult(JSON.stringify(result), [reference], evidence), /comparisons/);
    result.frames[0]!.checks.layout!.status = "passed";
    await writeFile(join(evidence, "frame.png"), referencePng);
    await assert.rejects(validateDesignResult(JSON.stringify(result), [reference], evidence), /not application/);
  } finally { await f.cleanup(); }
});

test("Figma controller fetches with trusted CLI once, caches designs, and uses isolated verifier sessions", async () => {
  const f = await fixture();
  let fetches = 0; const sessions = new Set<string>();
  try {
    const cli = join(f.config.agentDir, "skills/figma/scripts/figma.py");
    await mkdir(join(f.config.agentDir, "skills/figma/scripts"), { recursive: true }); await writeFile(cli, "# trusted fixture");
    const run: typeof execFile = async (command, args, options) => {
      fetches++;
      assert.equal(command, "python3"); assert.deepEqual(args.slice(0, 4), ["-I", "-B", cli, "fetch"]);
      assert.equal(options?.cwd, f.worktree);
      const directory = args.at(-1)!; await mkdir(directory);
      await writeFile(join(directory, "manifest.json"), JSON.stringify({ complete: true, fileKey: target.fileKey, nodeId: target.nodeId, version: "v1" }));
      await writeFile(join(directory, "design.json"), "{}"); await writeFile(join(directory, "summary.json"), "{}");
      await writeFile(join(directory, "reference.png"), referencePng);
      return { stdout: "not logged", stderr: "", exitCode: 0 };
    };
    const agent: Pick<PiAgentRunner, "run"> = { run: async (options) => {
      assert.equal(options.sessionFile, null); assert.equal(options.visualVerification, true);
      assert.ok(!sessions.has(options.sessionDir)); sessions.add(options.sessionDir);
      const reference = { ...target, directory: options.verification!.readPaths[0]!, version: "v1" };
      await writeFile(join(options.verification!.evidenceDir, "frame.png"), png);
      assert.equal(options.dockerAccess, false);
      return { sessionFile: join(options.sessionDir, "design.jsonl"), finalText: JSON.stringify(designVerdict(reference)),
        verificationEvidence: { commands: [{ command: "playwright-cli -s=test screenshot frame.png", output: "captured" }],
          readPaths: [join(reference.directory, "reference.png"), join(reference.directory, "summary.json"), join(options.verification!.evidenceDir, "frame.png")] } };
    } };
    const service = new FigmaVerificationService(f.config, agent, run);
    assert.equal(await service.verify(issue, f.worktree), null);
    const linked = { ...issue, body: target.url };
    await service.verify(linked, f.worktree); await service.verify(linked, f.worktree);
    assert.equal(fetches, 1); assert.equal(sessions.size, 2);
  } finally { await f.cleanup(); }
});

test("verifier sandbox denies source writes even under /tmp and grants only private evidence writes", async () => {
  const f = await fixture();
  try {
    const evidenceDir = join(f.root, "evidence");
    const reference = join(f.root, "reference");
    const sandbox = sandboxConfig(f.worktree, f.config, { privateTemp: join(f.root, "private-temp"), verification: { readPaths: [reference], evidenceDir } });
    assert.ok(!sandbox.filesystem.allowWrite.includes("/tmp"));
    assert.ok(!sandbox.filesystem.allowWrite.includes(f.worktree));
    assert.ok(sandbox.filesystem.denyWrite.includes(f.worktree));
    assert.ok(sandbox.filesystem.allowWrite.includes(evidenceDir));
    assert.ok(!sandbox.filesystem.allowWrite.includes(reference));
    assert.ok(sandbox.filesystem.allowRead?.includes(reference));
  } finally { await f.cleanup(); }
});

test("Figma 429 stops immediately without retry or verifier invocation", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const dir = join(f.config.agentDir, "skills/figma/scripts"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "figma.py"), "fixture");
    const service = new FigmaVerificationService(f.config, { run: async () => { throw new Error("must not run"); } }, async () => {
      calls++; return { exitCode: 3, stdout: "", stderr: "Figma rate limit reached (HTTP 429). Retry after 123 seconds. No automatic retry." };
    });
    await assert.rejects(service.verify({ ...issue, body: target.url }, f.worktree), /429.*123/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});
