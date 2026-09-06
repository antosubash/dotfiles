import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
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
import type { AgentRunResult } from "./types.js";
import { AGENT_POLICY, headlessPolicyExtension } from "./agent/policy.js";
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
}

const GITHUB_SECRET_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;

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
    const available = await runtime.getAvailable();
    const selected = available.find(
      (model) => `${model.provider}/${model.id}` === this.config.model,
    );
    if (!selected) {
      throw new Error(
        `Configured Pi model ${this.config.model} is not available or authenticated in ${this.config.agentDir}`,
      );
    }
    return selected;
  }

  async assertAvailable(): Promise<void> {
    await this.selectedModel();
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const saved = new Map<string, string>();
    for (const name of GITHUB_SECRET_ENV) {
      const value = process.env[name];
      if (value !== undefined) saved.set(name, value);
      delete process.env[name];
    }
    try {
      return await this.runWithScrubbedGithubEnvironment(options);
    } finally {
      for (const name of GITHUB_SECRET_ENV) delete process.env[name];
      for (const [name, value] of saved) process.env[name] = value;
    }
  }

  private async runWithScrubbedGithubEnvironment(options: AgentRunOptions): Promise<AgentRunResult> {
    await mkdir(options.sessionDir, { recursive: true });
    await mkdir(dirname(options.logFile), { recursive: true });
    const processGroupFile = activeCommandProcessGroupPath(this.config.dataDir);
    const visualVerification = options.visualVerification === true;
    const dockerAccess = options.dockerAccess === true;
    if (dockerAccess && (!this.config.allowDocker || !this.config.dockerSocket)) {
      throw new Error("Docker access was requested but is not enabled for this worker profile");
    }
    const tempRoot = sandboxTempRoot(visualVerification || dockerAccess);
    await removeStaleSandboxTemps(tempRoot);
    // Keep this short: Unix-domain browser socket paths are limited to roughly 108 bytes on Linux.
    const sandboxTemp = await mkdtemp(join(tempRoot, "piw-"));
    await writeFile(join(sandboxTemp, ".owner-pid"), `${process.pid}\n`, { mode: 0o600 });
    const restoreEnvironment = applySandboxTempEnvironment(sandboxTemp, (visualVerification || dockerAccess) && process.platform === "linux");
    const shutdownController = new AbortController();
    const onInterrupt = () => shutdownController.abort();
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    let sandboxInitialized = true;
    try {
      await SandboxManager.initialize(
        sandboxConfig(options.worktree, this.config, {
          privateTemp: sandboxTemp,
          visualVerification: options.visualVerification === true,
          dockerSocket: dockerAccess ? this.config.dockerSocket : null,
        }),
      );
      if (process.platform === "linux" && (visualVerification || dockerAccess)) {
        assertVisualSandboxIsolation(await SandboxManager.wrapWithSandbox("true"));
      }
      const settingsManager = SettingsManager.create(options.worktree, this.config.agentDir);
      const sandboxedBashOperations = createSandboxedBashOperations(
        processGroupFile,
        shutdownController.signal,
        dockerAccess && this.config.dockerSocket
          ? { DOCKER_HOST: `unix://${this.config.dockerSocket}` }
          : {},
      );
      const loader = new DefaultResourceLoader({
        cwd: options.worktree,
        agentDir: this.config.agentDir,
        settingsManager,
        appendSystemPrompt: [AGENT_POLICY],
        // Executable user/project extensions run in the controller process, outside the bash sandbox.
        // Disable discovery and register only the worker-owned inline policy extension below.
        noExtensions: true,
        extensionFactories: [headlessPolicyExtension({ worktree: options.worktree, protectedPaths: this.config.protectedPaths, dockerAccess, bashOperations: sandboxedBashOperations })],
      });
      // Keep project settings untrusted so a pre-created issue branch cannot enable executable packages.
      await loader.reload({ resolveProjectTrust: async () => false });

      const hasSession = options.sessionFile
        ? await access(options.sessionFile)
            .then(() => true)
            .catch(() => false)
        : false;
      const sessionManager = hasSession && options.sessionFile
        ? SessionManager.open(options.sessionFile, options.sessionDir, options.worktree)
        : SessionManager.create(options.worktree, options.sessionDir);
      const modelRuntime = await this.modelRuntimePromise;
      const model = await this.selectedModel();
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: options.worktree,
        agentDir: this.config.agentDir,
        modelRuntime,
        model,
        thinkingLevel: this.config.thinkingLevel,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        resourceLoader: loader,
        sessionManager,
        settingsManager,
      });

      const settlementWatchdog = createAgentSettlementWatchdog(5 * 60_000);
      let resolveAgentSettled: (() => void) | undefined;
      const agentSettled = new Promise<void>((resolveTerminal) => {
        resolveAgentSettled = resolveTerminal;
      });
      const unsubscribe = session.subscribe((event) => {
        settlementWatchdog.progress();
        if (event.type === "tool_execution_start") {
          void appendFile(options.logFile, `${new Date().toISOString()} tool ${event.toolName}\n`);
        } else if (event.type === "agent_end") {
          void appendFile(
            options.logFile,
            `${new Date().toISOString()} agent_end retry=${String(event.willRetry)}\n`,
          );
          if (!event.willRetry) settlementWatchdog.arm();
        } else if (event.type === "agent_settled") {
          settlementWatchdog.settled();
          void appendFile(options.logFile, `${new Date().toISOString()} agent_settled\n`);
          resolveAgentSettled?.();
        }
      });

      try {
        if (modelFallbackMessage) {
          await appendFile(options.logFile, `${modelFallbackMessage}\n`);
        }
        const prompt = session.prompt(options.prompt);
        let completion: "prompt" | "agent_settled";
        try {
          completion = await awaitAgentPromptCompletion(
            prompt,
            agentSettled,
            this.config.agentTimeoutMinutes * 60_000,
            3_000,
            settlementWatchdog.failure,
          );
          settlementWatchdog.close();
        } catch (error) {
          settlementWatchdog.close();
          let abortTimer: NodeJS.Timeout | undefined;
          let abortSucceeded = false;
          await Promise.race([
            session.abort().then(() => {
              abortSucceeded = true;
            }),
            new Promise<void>((_resolve, reject) => {
              abortTimer = setTimeout(() => reject(new Error("Pi agent abort timed out")), 10_000);
            }),
          ]).catch(() => undefined);
          if (abortTimer) clearTimeout(abortTimer);
          if (!abortSucceeded) {
            await appendFile(
              options.logFile,
              `${new Date().toISOString()} fatal agent stall; restarting repository worker\n`,
            ).catch(() => undefined);
            // Continuing would restore the global sandbox while the SDK may still mutate the worktree.
            // The supervisor restarts this isolated repository child and state recovery resumes safely.
            process.exit(75);
          }
          throw error;
        }
        if (completion === "agent_settled") {
          // agent_settled is emitted only after retries, compaction, queued continuations, and tool work
          // finish. Some SDK/resource cleanup paths have still failed to settle prompt() afterward.
          void prompt.catch(() => undefined);
          await appendFile(
            options.logFile,
            `${new Date().toISOString()} recovered terminal agent result after prompt settlement grace\n`,
          );
        }
        const final = extractAssistantText(session.messages);
        if (final.stopReason === "error" || final.stopReason === "aborted") {
          throw new Error(final.error || `Pi stopped with ${final.stopReason}`);
        }
        if (!session.sessionFile) throw new Error("Pi did not create a persistent session file");
        return { sessionFile: session.sessionFile, finalText: final.text.trim() };
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
          if (sandboxInitialized) await SandboxManager.reset();
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
