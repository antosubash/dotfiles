import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createRegistry,
  defineExtension,
  hook,
  ToolTask,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { toolBlockReason, type ToolPolicyOptions } from "../policy.js";
import { workerPromptSections, type WorkerPrompt } from "./prompt.js";
import { createSearchTools } from "./search-tools.js";

/** Tools a planning run may use: read-only, no bash, so its codemode scripts cannot reach bash either. */
export const PLANNING_TOOLS = ["read", "grep", "find", "ls", "codemode"] as const;
export const IMPLEMENTATION_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode"] as const;

export function agentTools(planning: boolean): string[] {
  return [...(planning ? PLANNING_TOOLS : IMPLEMENTATION_TOOLS)];
}

export interface WorkerRegistry {
  readonly registry: Registry;
  /** The worker's tool registrations by name, to select a run's tools with `configure({ tools })`. */
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  close(): Promise<void>;
}

/**
 * One run's extensions: the durable coding tools, read-only search tools, codemode (with `models` off: unattended
 * runs never spend on classifiers or image generation), and the worker extension carrying the prompt sections and
 * the tool policy. The policy is a `beforeTool` hook, which the Harness runs for model calls and for every nested
 * call a codemode script makes.
 */
export function createWorkerRegistry(policy: ToolPolicyOptions, prompt: WorkerPrompt): WorkerRegistry {
  const sandbox = new CodemodeSandbox();
  const coding = createCodingTools();
  const search = defineExtension({ name: "worker-search", tools: createSearchTools() });
  const codemode = createCodemodeExtension({ sandbox, models: false });
  const worker = defineExtension({
    name: "worker",
    sections: workerPromptSections(prompt),
    hooks: [hook(ToolTask, {
      beforeTool: (call) => {
        const reason = toolBlockReason(call.name, call.arguments as { command?: unknown; path?: unknown }, policy);
        return reason === null ? undefined : { block: reason };
      },
    })],
  });
  const registry = createRegistry();
  const extensions: Extension[] = [coding, search, codemode, worker];
  for (const extension of extensions) registry.install(extension);
  const tools = new Map<string, ToolRegistration>();
  for (const extension of extensions) for (const tool of extension.tools ?? []) tools.set(tool.name, tool as ToolRegistration);
  return { registry, tools, close: () => sandbox.close() };
}
