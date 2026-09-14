import { access, appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { WorkerConfig } from "./config.js";
import type { AgentRunResult, VerificationEvidence } from "./types.js";
import { AGENT_POLICY, headlessPolicyExtension, type VerificationOptions } from "./agent/policy.js";
import {
  awaitAgentPromptCompletion,
  createAgentSettlementWatchdog,
  extractAssistantText,
} from "./agent/settlement.js";
import { cgroupController, ownCgroupPath, type CgroupController } from "./agent/cgroup.js";
import { openIsolation, type Isolation } from "./agent/isolation.js";
import { activeCommandProcessGroupPath } from "./agent/process-group.js";

interface AgentRunOptions {
  worktree: string;
  sessionDir: string;
  sessionFile: string | null;
  prompt: string;
  logFile: string;
  visualVerification?: boolean;
  dockerAccess?: boolean;
  verification?: VerificationOptions;
  planning?: boolean;
  /** Per-run variables for agent bash, e.g. a running app instance's `PI_QA_*` values. */
  environment?: NodeJS.ProcessEnv;
}

const SECRET_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "FIGMA_TOKEN", "FIGMA_TOKEN_FILE"] as const;

export class PiAgentRunner {
  private readonly modelRuntimePromise: Promise<ModelRuntime>;
  private readonly cgroups: CgroupController;

  constructor(private readonly config: WorkerConfig, dependencies: { cgroups?: CgroupController } = {}) {
    this.cgroups = dependencies.cgroups ?? cgroupController(ownCgroupPath());
    this.modelRuntimePromise = ModelRuntime.create({
      authPath: resolve(config.agentDir, "auth.json"),
      modelsPath: resolve(config.agentDir, "models.json"),
    });
  }

  private async selectedModel() {
    const runtime = await this.modelRuntimePromise;
    const selected = (await runtime.getAvailable()).find(
      (model) => `${model.provider}/${model.id}` === this.config.model,
    );
    if (!selected) {
      throw new Error(`Configured Pi model ${this.config.model} is not available or authenticated in ${this.config.agentDir}`);
    }
    return selected;
  }

  async assertAvailable(): Promise<void> {
    await this.selectedModel();
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const saved = new Map<string, string>();
    for (const name of SECRET_ENV) {
      const value = process.env[name];
      if (value !== undefined) saved.set(name, value);
      delete process.env[name];
    }
    try {
      return await this.runWithScrubbedEnvironment(options);
    } finally {
      for (const name of SECRET_ENV) delete process.env[name];
      for (const [name, value] of saved) process.env[name] = value;
    }
  }

  private async runWithScrubbedEnvironment(options: AgentRunOptions): Promise<AgentRunResult> {
    await mkdir(options.sessionDir, { recursive: true });
    await mkdir(dirname(options.logFile), { recursive: true });
    const dockerAccess = options.dockerAccess === true;
    const shutdownController = new AbortController();
    const onInterrupt = () => shutdownController.abort();
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    let isolation: Isolation | null = null;
    try {
      isolation = await openIsolation(this.config, {
        worktree: options.worktree,
        processGroupFile: activeCommandProcessGroupPath(this.config.dataDir),
        visualVerification: options.visualVerification === true,
        dockerAccess,
        ...(options.verification ? { verification: options.verification } : {}),
        shutdownSignal: shutdownController.signal,
        cgroups: this.cgroups,
        ...(options.environment ? { environment: options.environment } : {}),
      });
      const settingsManager = SettingsManager.create(options.worktree, this.config.agentDir);
      const bashOperations = isolation.bashOperations;
      const loader = new DefaultResourceLoader({
        cwd: options.worktree,
        agentDir: this.config.agentDir,
        settingsManager,
        appendSystemPrompt: [AGENT_POLICY, ...(options.verification ? [
          `Independent verification mode: do not modify source. Read-only access is limited to ${JSON.stringify(options.verification.readPaths)} and writes to ${JSON.stringify(options.verification.evidenceDir)}. Return an independent verdict, never implementation changes.`,
        ] : [])],
        noExtensions: true,
        extensionFactories: [headlessPolicyExtension({
          worktree: options.worktree,
          protectedPaths: this.config.protectedPaths,
          dockerAccess,
          bashOperations,
          sandboxed: isolation.sandboxed,
          credentialPaths: [this.config.agentDir],
          ...(options.verification ? { verification: options.verification } : {}),
        })],
      });
      await loader.reload({ resolveProjectTrust: async () => false });
      const hasSession = options.sessionFile
        ? await access(options.sessionFile).then(() => true).catch(() => false)
        : false;
      const sessionManager = hasSession && options.sessionFile
        ? SessionManager.open(options.sessionFile, options.sessionDir, options.worktree)
        : SessionManager.create(options.worktree, options.sessionDir);
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: options.worktree,
        agentDir: this.config.agentDir,
        modelRuntime: await this.modelRuntimePromise,
        model: await this.selectedModel(),
        thinkingLevel: this.config.thinkingLevel,
        tools: options.planning ? ["read", "grep", "find", "ls"] : ["read", "bash", "edit", "write", "grep", "find", "ls"],
        resourceLoader: loader,
        sessionManager,
        settingsManager,
      });
      const settlementWatchdog = createAgentSettlementWatchdog(5 * 60_000);
      let resolveAgentSettled: (() => void) | undefined;
      const agentSettled = new Promise<void>((resolveTerminal) => { resolveAgentSettled = resolveTerminal; });
      const verificationEvidence: VerificationEvidence = { commands: [], readPaths: [] };
      const toolInputs = new Map<string, { toolName: string; args: { command?: string; path?: string } }>();
      const unsubscribe = session.subscribe((event) => {
        settlementWatchdog.progress();
        if (options.verification && event.type === "tool_execution_start") {
          toolInputs.set(event.toolCallId, { toolName: event.toolName, args: event.args as { command?: string; path?: string } });
        }
        if (options.verification && event.type === "tool_execution_end") {
          const input = toolInputs.get(event.toolCallId);
          toolInputs.delete(event.toolCallId);
          if (!event.isError && input?.toolName === "bash" && typeof input.args.command === "string") {
            const output = (event.result as { content?: Array<{ type: string; text?: string }> }).content
              ?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
            verificationEvidence.commands.push({ command: input.args.command, output: output.slice(-32_000) });
          } else if (!event.isError && input?.toolName === "read" && typeof input.args.path === "string") {
            verificationEvidence.readPaths.push(resolve(options.worktree, input.args.path.replace(/^@/, "")));
          }
        }
        if (event.type === "tool_execution_start") {
          void appendFile(options.logFile, `${new Date().toISOString()} tool ${event.toolName}\n`);
        } else if (event.type === "agent_end") {
          void appendFile(options.logFile, `${new Date().toISOString()} agent_end retry=${String(event.willRetry)}\n`);
          if (!event.willRetry) settlementWatchdog.arm();
        } else if (event.type === "agent_settled") {
          settlementWatchdog.settled();
          void appendFile(options.logFile, `${new Date().toISOString()} agent_settled\n`);
          resolveAgentSettled?.();
        }
      });
      try {
        if (modelFallbackMessage) await appendFile(options.logFile, `${modelFallbackMessage}\n`);
        const prompt = session.prompt(options.prompt);
        let completion: "prompt" | "agent_settled";
        try {
          completion = await awaitAgentPromptCompletion(
            prompt, agentSettled, this.config.agentTimeoutMinutes * 60_000, 3_000, settlementWatchdog.failure,
          );
          settlementWatchdog.close();
        } catch (error) {
          settlementWatchdog.close();
          let abortTimer: NodeJS.Timeout | undefined;
          let abortSucceeded = false;
          await Promise.race([
            session.abort().then(() => { abortSucceeded = true; }),
            new Promise<void>((_resolve, reject) => { abortTimer = setTimeout(() => reject(new Error("Pi agent abort timed out")), 10_000); }),
          ]).catch(() => undefined);
          if (abortTimer) clearTimeout(abortTimer);
          if (!abortSucceeded) {
            await appendFile(options.logFile, `${new Date().toISOString()} fatal agent stall; restarting repository worker\n`).catch(() => undefined);
            process.exit(75);
          }
          throw error;
        }
        if (completion === "agent_settled") {
          void prompt.catch(() => undefined);
          await appendFile(options.logFile, `${new Date().toISOString()} recovered terminal agent result after prompt settlement grace\n`);
        }
        const final = extractAssistantText(session.messages);
        if (final.stopReason === "error" || final.stopReason === "aborted") {
          throw new Error(final.error || `Pi stopped with ${final.stopReason}`);
        }
        if (!session.sessionFile) throw new Error("Pi did not create a persistent session file");
        return {
          sessionFile: session.sessionFile,
          finalText: final.text.trim(),
          ...(options.verification ? { verificationEvidence } : {}),
        };
      } finally {
        unsubscribe();
        session.dispose();
        await settingsManager.flush();
      }
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      await isolation?.close();
    }
  }
}

export { commandBlockReason } from "./agent/policy.js";
export { awaitAgentPromptCompletion, createAgentSettlementWatchdog } from "./agent/settlement.js";
export { assertVisualSandboxIsolation, removeStaleSandboxTemps, sandboxConfig, sandboxEnvironment } from "./agent/sandbox.js";
export { ACTIVE_COMMAND_PROCESS_GROUP_FILE, activeCommandProcessGroupPath, createBashOperations, stopTrackedProcessGroup } from "./agent/process-group.js";
export { cgroupController, ownCgroupPath, type CgroupController } from "./agent/cgroup.js";
