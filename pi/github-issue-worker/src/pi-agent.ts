import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Harness, watchEvents, type Conversation, type Submission } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { WorkerConfig } from "./config.js";
import type { AgentRunResult } from "./types.js";
import type { VerificationOptions } from "./agent/policy.js";
import { cgroupController, ownCgroupPath, type CgroupController } from "./agent/cgroup.js";
import { openIsolation, type Isolation } from "./agent/isolation.js";
import { activeCommandProcessGroupPath } from "./agent/process-group.js";
import { IsolatedExecutionEnv } from "./agent/durable/env.js";
import { createRunEventSink } from "./agent/durable/events.js";
import { loadWorkerPrompt } from "./agent/durable/prompt.js";
import { agentTools, createWorkerRegistry } from "./agent/durable/registry.js";
import { durableSessionPath, settledAnswer, submitPrompt } from "./agent/durable/run.js";
import { privateQaManifestPath } from "./qa-manifest-source.js";

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

const SECRET_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "FIGMA_TOKEN", "FIGMA_TOKEN_FILE"] as const;

export class PiAgentRunner {
  private readonly modelRuntimePromise: Promise<Models>;
  private readonly cgroups: CgroupController;

  constructor(private readonly config: WorkerConfig, dependencies: { cgroups?: CgroupController; models?: Models } = {}) {
    this.cgroups = dependencies.cgroups ?? cgroupController(ownCgroupPath());
    this.modelRuntimePromise = dependencies.models ? Promise.resolve(dependencies.models) : ModelRuntime.create({
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
    const log = (line: string) => appendFile(options.logFile, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
    const sessionFile = durableSessionPath(options.sessionDir, options.sessionFile);
    if (options.sessionFile && options.sessionFile !== sessionFile) await log("previous JSONL session left behind; continuing in a durable session");
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
        dockerAccess: options.dockerAccess === true,
        ...(options.verification ? { verification: options.verification } : {}),
        shutdownSignal: shutdownController.signal,
        cgroups: this.cgroups,
        ...(options.environment ? { environment: options.environment } : {}),
      });
      return await this.runDurable(options, isolation, sessionFile, shutdownController.signal, log);
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      await isolation?.close();
    }
  }

  private async runDurable(
    options: AgentRunOptions,
    isolation: Isolation,
    sessionFile: string,
    shutdownSignal: AbortSignal,
    log: (line: string) => Promise<void>,
  ): Promise<AgentRunResult> {
    const context = BACKGROUND_CONTEXT;
    const model = await this.selectedModel();
    const settings = SettingsManager.create(options.worktree, this.config.agentDir);
    const prompt = await loadWorkerPrompt({
      worktree: options.worktree,
      agentDir: this.config.agentDir,
      ...(options.verification ? { verification: options.verification } : {}),
    });
    const workers = createWorkerRegistry({
      worktree: options.worktree,
      protectedPaths: this.config.protectedPaths,
      dockerAccess: options.dockerAccess === true,
      credentialPaths: [this.config.agentDir, privateQaManifestPath(this.config)],
      ...(options.verification ? { verification: options.verification } : {}),
    }, prompt);
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(await openNodeSqliteStorage(sessionFile), {
        models: await this.modelRuntimePromise,
        registry: workers.registry,
        env: () => new IsolatedExecutionEnv(options.worktree, isolation.bashOperations),
        settings: { compaction: settings.getCompactionSettings(model), retry: settings.getRetrySettings() },
        onReport: (error) => void log(`harness report: ${error instanceof Error ? error.message : String(error)}`),
      }, context);
      const sink = createRunEventSink({ log, worktree: options.worktree, collectEvidence: Boolean(options.verification) });
      const root = await harness.root(context);
      await root.configure({
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: this.config.thinkingLevel,
        tools: agentTools(options.planning === true).flatMap((name) => workers.tools.get(name) ?? []),
        cwd: options.worktree,
      }, context);
      const events = await watchEvents(harness, root.id, context);
      events.start(async (batch) => sink.handle(batch));
      try {
        const submission = await submitPrompt(
          root, options.prompt, context, () => void log("abandoning an unfinished earlier run"), options.sessionFile === sessionFile,
        );
        const finalText = await this.waitForAnswer(root, submission, shutdownSignal, log);
        return { sessionFile, finalText, ...(options.verification ? { verificationEvidence: sink.evidence } : {}) };
      } finally {
        await events.stop();
      }
    } finally {
      // The sandbox is created with the registry, before the store opens, so it is closed on every path.
      try {
        await harness?.close(context);
      } finally {
        await workers.close();
      }
    }
  }

  /**
   * Waits for the run's answer within the agent timeout. On timeout the run is aborted (a stuck abort restarts the
   * repository worker, exit 75). On shutdown it is left pending: the next process reopens the store and resumes it.
   */
  private async waitForAnswer(
    root: Conversation,
    submission: Submission,
    shutdownSignal: AbortSignal,
    log: (line: string) => Promise<void>,
  ): Promise<string> {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(new Error("timeout")); }, this.config.agentTimeoutMinutes * 60_000);
    const onShutdown = () => cancel(new Error("shutdown"));
    shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    // A shutdown that began while the prompt was being submitted would never fire the listener.
    if (shutdownSignal.aborted) onShutdown();
    try {
      return await settledAnswer(root, submission, context);
    } catch (error) {
      if (shutdownSignal.aborted) {
        await log("worker shutting down; the run stays pending and resumes on restart");
        throw new Error("Pi agent interrupted by worker shutdown", { cause: error });
      }
      if (!timedOut) throw error;
      await log(`agent timed out after ${this.config.agentTimeoutMinutes} minutes; aborting`);
      let abortTimer: NodeJS.Timeout | undefined;
      const aborted = await Promise.race([
        root.abort(BACKGROUND_CONTEXT).then(() => true),
        new Promise<false>((resolveAbort) => { abortTimer = setTimeout(() => resolveAbort(false), 10_000); }),
      ]).catch(() => false);
      if (abortTimer) clearTimeout(abortTimer);
      if (!aborted) {
        await log("fatal agent stall; restarting repository worker");
        process.exit(75);
      }
      throw new Error(`Pi agent timed out after ${this.config.agentTimeoutMinutes} minutes`, { cause: error });
    } finally {
      clearTimeout(timer);
      shutdownSignal.removeEventListener("abort", onShutdown);
    }
  }
}

export { commandBlockReason } from "./agent/policy.js";
export { assertVisualSandboxIsolation, removeStaleSandboxTemps, sandboxConfig, sandboxEnvironment } from "./agent/sandbox.js";
export { ACTIVE_COMMAND_PROCESS_GROUP_FILE, activeCommandProcessGroupPath, createBashOperations, stopTrackedProcessGroup } from "./agent/process-group.js";
export { cgroupController, ownCgroupPath, type CgroupController } from "./agent/cgroup.js";
