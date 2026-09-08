import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { WorkerConfig } from "./config.js";
import type { AgentRunResult, VerificationEvidence } from "./types.js";
import { AGENT_POLICY, headlessPolicyExtension, type VerificationOptions } from "./agent/policy.js";
import {
  awaitAgentPromptCompletion,
  createAgentSettlementWatchdog,
  extractAssistantText,
} from "./agent/settlement.js";
import {
  applySandboxTempEnvironment,
  assertVisualSandboxIsolation,
  removeStaleSandboxTemps,
  sandboxConfig,
  sandboxTempRoot,
} from "./agent/sandbox.js";
import {
  activeCommandProcessGroupPath,
  createSandboxedBashOperations,
  stopTrackedProcessGroup,
} from "./agent/process-group.js";

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
}

const SECRET_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "FIGMA_TOKEN", "FIGMA_TOKEN_FILE"] as const;

export class PiAgentRunner {
  private readonly modelRuntimePromise: Promise<ModelRuntime>;

  constructor(private readonly config: WorkerConfig) {
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
    const processGroupFile = activeCommandProcessGroupPath(this.config.dataDir);
    const visualVerification = options.visualVerification === true;
    const dockerAccess = options.dockerAccess === true;
    if (options.verification && dockerAccess) throw new Error("Independent verifiers cannot access the Docker daemon.");
    if (dockerAccess && (!this.config.allowDocker || !this.config.dockerSocket)) {
      throw new Error("Docker access was requested but is not enabled for this worker profile");
    }
    const tempRoot = sandboxTempRoot(visualVerification || dockerAccess);
    await removeStaleSandboxTemps(tempRoot);
    const sandboxTemp = await mkdtemp(join(tempRoot, "piw-"));
    await writeFile(join(sandboxTemp, ".owner-pid"), `${process.pid}\n`, { mode: 0o600 });
    const restoreEnvironment = applySandboxTempEnvironment(
      sandboxTemp,
      Boolean(options.verification) || (visualVerification || dockerAccess) && process.platform === "linux",
    );
    const shutdownController = new AbortController();
    const onInterrupt = () => shutdownController.abort();
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    try {
      await SandboxManager.initialize(sandboxConfig(options.worktree, this.config, {
        privateTemp: sandboxTemp,
        visualVerification,
        dockerSocket: dockerAccess ? this.config.dockerSocket : null,
        ...(options.verification ? { verification: options.verification } : {}),
      }));
      if (process.platform === "linux" && (visualVerification || dockerAccess)) {
        assertVisualSandboxIsolation(await SandboxManager.wrapWithSandbox("true"));
      }
      const settingsManager = SettingsManager.create(options.worktree, this.config.agentDir);
      const bashOperations = createSandboxedBashOperations(
        processGroupFile,
        shutdownController.signal,
        dockerAccess && this.config.dockerSocket ? { DOCKER_HOST: `unix://${this.config.dockerSocket}` } : {},
      );
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
      try {
        await stopTrackedProcessGroup(processGroupFile);
      } finally {
        try {
          await SandboxManager.reset();
        } finally {
          restoreEnvironment();
          await rm(sandboxTemp, { recursive: true, force: true });
        }
      }
    }
  }
}

export { commandBlockReason } from "./agent/policy.js";
export { awaitAgentPromptCompletion, createAgentSettlementWatchdog } from "./agent/settlement.js";
export { assertVisualSandboxIsolation, removeStaleSandboxTemps, sandboxConfig, sandboxEnvironment } from "./agent/sandbox.js";
export { ACTIVE_COMMAND_PROCESS_GROUP_FILE, activeCommandProcessGroupPath, createSandboxedBashOperations, stopTrackedProcessGroup } from "./agent/process-group.js";
