import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { activeCommandProcessGroupPath, stopTrackedProcessGroup } from "../src/pi-agent.js";
import { fauxRunner } from "./helpers/durable-runner.js";

const toolUse = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });

/** A final answer that records the text of every tool result the model was shown. */
function answerAfterReading(seen: string[], answer: string): FauxResponseFactory {
  return (context) => {
    for (const message of context.messages) {
      if (message.role === "toolResult") seen.push(JSON.stringify(message.content));
    }
    return fauxAssistantMessage(answer);
  };
}

async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-durable-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("policy blocks GitHub CLI in direct and codemode-nested bash while other calls run", () => withRoot(async (root) => {
  const seen: string[] = [];
  const { run } = await fauxRunner(root, [
    toolUse("codemode", {
      code: 'const r = await Promise.allSettled([tools.bash({ command: "gh issue list" }), tools.bash({ command: "echo nested-ok" })]);\n' +
        'return r.map((x) => x.status === "fulfilled" ? x.value.output.trim() : String(x.reason.message));',
    }),
    toolUse("bash", { command: "gh pr list" }),
    answerAfterReading(seen, "done"),
  ]);
  const result = await run("check the policy");
  assert.equal(result.finalText, "done");
  assert.match(result.sessionFile, /harness\.sqlite$/);
  const text = seen.join("\n");
  assert.match(text, /nested-ok/);
  assert.equal(text.match(/GitHub CLI writes and reads belong to the controller/g)?.length, 2);
}));

test("planning runs offer no bash, directly or through codemode", () => withRoot(async (root) => {
  const seen: string[] = [];
  const { run, worktree } = await fauxRunner(root, [
    toolUse("codemode", { code: 'return "bash" in tools;' }),
    toolUse("bash", { command: "echo should-not-run" }),
    toolUse("grep", { pattern: "needle" }),
    toolUse("find", { pattern: "*.md" }),
    toolUse("ls", {}),
    answerAfterReading(seen, "planned"),
  ]);
  await writeFile(join(worktree, "plan.md"), "a needle here\n");
  assert.equal((await run("plan it", { planning: true })).finalText, "planned");
  const text = seen.join("\n");
  assert.match(text, /false/);
  // The search tools run through the isolated environment's bash operations.
  assert.match(text, /plan\.md:1: a needle here/);
  assert.match(text, /plan\.md\\n|plan\.md"/);
  assert.doesNotMatch(text, /should-not-run\\n/);
}));

test("the same prompt reattaches to its answered run; a new prompt continues the conversation", () => withRoot(async (root) => {
  const { faux, run } = await fauxRunner(root, [
    fauxAssistantMessage("first answer"),
    (context) => fauxAssistantMessage(`saw ${context.messages.filter((message) => message.role === "user").length} prompts`),
  ]);
  const first = await run("first prompt");
  // The controller never recorded the first run (it died before saving the session), so it asks again.
  assert.equal((await run("first prompt")).finalText, "first answer");
  assert.equal(faux.state.callCount, 1);
  const second = await run("second prompt", { sessionFile: first.sessionFile });
  assert.equal(second.finalText, "saw 2 prompts");
  assert.equal(second.sessionFile, first.sessionFile);
}));

test("a retry of a prompt whose answer the controller already recorded runs again instead of replaying the answer", () => withRoot(async (root) => {
  const { faux, run } = await fauxRunner(root, [
    fauxAssistantMessage("BLOCKED: no access"),
    fauxAssistantMessage("fixed it"),
  ]);
  const first = await run("implement the issue");
  assert.equal(first.finalText, "BLOCKED: no access");
  // The controller saved `first.sessionFile`, rejected the BLOCKED answer, and retries with the identical prompt.
  assert.equal((await run("implement the issue", { sessionFile: first.sessionFile })).finalText, "fixed it");
  assert.equal(faux.state.callCount, 2);
}));

test("a retry after a failed run starts a new run instead of reattaching to the failure", () => withRoot(async (root) => {
  const { faux, run } = await fauxRunner(root, [
    fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "provider exploded" }),
    fauxAssistantMessage("second try"),
  ]);
  await assert.rejects(run("flaky prompt"), /provider exploded/);
  // The controller records no session file for a failed run and reissues the same prompt.
  assert.equal((await run("flaky prompt")).finalText, "second try");
  assert.equal(faux.state.callCount, 2);
}));

test("verifier runs collect bash and read evidence", () => withRoot(async (root) => {
  const evidenceDir = join(root, "evidence");
  const { run, worktree } = await fauxRunner(root, [
    toolUse("bash", { command: "echo evidence-output" }),
    toolUse("read", { path: "notes.txt" }),
    fauxAssistantMessage("verified"),
  ]);
  await writeFile(join(worktree, "notes.txt"), "notes");
  const result = await run("verify", { verification: { evidenceDir, readPaths: [] } });
  assert.equal(result.finalText, "verified");
  assert.deepEqual(result.verificationEvidence?.commands.map((entry) => entry.command), ["echo evidence-output"]);
  assert.match(result.verificationEvidence?.commands[0]?.output ?? "", /evidence-output/);
  assert.deepEqual(result.verificationEvidence?.readPaths, [join(worktree, "notes.txt")]);
}));

/** Starts the child fixture, waits until its bash call is running, and SIGKILLs it mid-call. */
async function crashMidTool(root: string, prompt: string): Promise<void> {
  // `node --import tsx`, not the tsx binary: the binary runs the script in a grandchild a kill would miss.
  const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "durable-runner-child.ts"), root, prompt], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "ignore",
  });
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const log = join(root, "data", "logs", "issue-1.log");
  const deadline = Date.now() + 30_000;
  while (!(await readFile(log, "utf8").catch(() => "")).includes("tool bash")) {
    if (Date.now() > deadline) throw new Error("child never started its bash call");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  child.kill("SIGKILL");
  await exited;
  // What the supervisor does when a repository worker exits: stop the commands it left running.
  await stopTrackedProcessGroup(activeCommandProcessGroupPath(join(root, "data")));
}

test("a run killed mid-tool resumes from its store with the call marked interrupted", () => withRoot(async (root) => {
  await crashMidTool(root, "long task");
  const seen: string[] = [];
  const { faux, run } = await fauxRunner(root, [answerAfterReading(seen, "recovered")]);
  const result = await run("long task");
  assert.equal(result.finalText, "recovered");
  assert.equal(faux.state.callCount, 1);
  assert.match(seen.join("\n"), /interrupted/);
}));

test("an unfinished run for another prompt is abandoned before the new prompt runs", () => withRoot(async (root) => {
  await crashMidTool(root, "stale task");
  const { run } = await fauxRunner(root, [fauxAssistantMessage("fresh answer")]);
  assert.equal((await run("fresh task")).finalText, "fresh answer");
  assert.match(await readFile(join(root, "data", "logs", "issue-1.log"), "utf8"), /abandoning an unfinished earlier run/);
}));
