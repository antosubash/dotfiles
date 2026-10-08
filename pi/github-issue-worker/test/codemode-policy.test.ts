import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { headlessPolicyExtension } from "../src/agent/policy.js";
import { createBashOperations } from "../src/agent/process-group.js";
import { agentTools } from "../src/pi-agent.js";

/**
 * Runs one codemode script through a real SDK session wired like PiAgentRunner (codemode + the headless
 * policy extension), with a faux model, and returns the codemode result and the nested tool names.
 */
async function runCodemodeScript(script: string, planning: boolean) {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-codemode-"));
  const faux = fauxProvider({ provider: "faux-worker" });
  try {
    const agentDir = join(root, "agent");
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [(pi) => pi.registerProvider(faux.provider), createCodemodeExtension({ mode: "on", models: false }), headlessPolicyExtension({
        worktree: root,
        protectedPaths: [],
        dockerAccess: false,
        bashOperations: createBashOperations(join(root, "active.pid"), { sandbox: false }),
        sandboxed: false,
      })],
    });
    await loader.reload({ resolveProjectTrust: async () => false });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: script } as never), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false }),
      model: faux.getModel(),
      tools: agentTools(planning),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });
    try {
      const nested: string[] = [];
      session.subscribe((event) => {
        if (event.type === "tool_execution_start" && "parentToolCallId" in event && event.parentToolCallId) {
          nested.push(event.toolName);
        }
      });
      const active = session.getActiveToolNames();
      await session.prompt("run it");
      const result = session.messages.find((message) => message.role === "toolResult");
      return { active, nested, text: JSON.stringify(result?.content) };
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("codemode is active and its nested bash calls still hit the worker policy", async () => {
  const { active, nested, text } = await runCodemodeScript(
    'const r = await Promise.allSettled([tools.bash({ command: "gh issue list" }), tools.bash({ command: "echo ok" })]);\n' +
      'return r.map((x) => x.status === "fulfilled" ? x.value.output.trim() : String(x.reason.message));',
    false,
  );
  assert.ok(active.includes("codemode"));
  assert.match(text, /GitHub CLI writes and reads belong to the controller/);
  assert.match(text, /\\"ok\\"/);
  assert.deepEqual(nested, ["bash", "bash"]);
});

test("planning codemode cannot reach bash", async () => {
  const { active, nested, text } = await runCodemodeScript('return "bash" in tools;', true);
  assert.ok(active.includes("codemode"));
  assert.ok(!active.includes("bash"));
  assert.match(text, /false/);
  assert.deepEqual(nested, []);
});
