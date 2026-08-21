#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadSupervisorProfiles,
  parseSupervisorOptions,
  type SupervisorMode,
  type SupervisorProfile,
} from "./supervisor-config.js";

const workerEntrypoint = fileURLToPath(new URL("./index.js", import.meta.url));

function timestamp(): string {
  return new Date().toISOString();
}

function workerArguments(mode: SupervisorMode): string[] {
  if (mode === "check") return [workerEntrypoint, "--check"];
  if (mode === "once") return [workerEntrypoint, "--once"];
  return [workerEntrypoint];
}

function spawnWorker(profile: SupervisorProfile, mode: SupervisorMode): ChildProcess {
  console.log(`${timestamp()} [${profile.name}] starting ${profile.config.repository}`);
  return spawn(process.execPath, workerArguments(mode), {
    env: profile.env,
    stdio: "inherit",
  });
}

async function runFinite(profiles: readonly SupervisorProfile[], mode: SupervisorMode): Promise<void> {
  const children = new Set<ChildProcess>();
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    for (const child of children) child.kill(signal);
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const results = await Promise.all(
      profiles.map(
        (profile) =>
          new Promise<{ name: string; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            const child = spawnWorker(profile, mode);
            children.add(child);
            child.once("close", (code, signal) => {
              children.delete(child);
              resolve({ name: profile.name, code, signal });
            });
          }),
      ),
    );
    const failures = results.filter((result) => result.code !== 0);
    if (stopping) throw new Error("Supervisor interrupted");
    if (failures.length > 0) {
      throw new Error(
        failures
          .map((result) => `${result.name} exited with ${result.signal || result.code || "unknown status"}`)
          .join("; "),
      );
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function runContinuously(
  profiles: readonly SupervisorProfile[],
  restartSeconds: number,
): Promise<void> {
  const children = new Map<string, ChildProcess>();
  const restartTimers = new Map<string, NodeJS.Timeout>();
  let stopping = false;
  let finish: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const maybeFinish = () => {
    if (stopping && children.size === 0) finish?.();
  };
  const launch = (profile: SupervisorProfile) => {
    if (stopping) return;
    const child = spawnWorker(profile, "run");
    children.set(profile.name, child);
    child.once("close", (code, signal) => {
      children.delete(profile.name);
      console.error(
        `${timestamp()} [${profile.name}] exited with ${signal || code || "unknown status"}`,
      );
      if (stopping) {
        maybeFinish();
        return;
      }
      const timer = setTimeout(() => {
        restartTimers.delete(profile.name);
        launch(profile);
      }, restartSeconds * 1_000);
      restartTimers.set(profile.name, timer);
    });
  };
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    for (const timer of restartTimers.values()) clearTimeout(timer);
    restartTimers.clear();
    for (const child of children.values()) child.kill(signal);
    maybeFinish();
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    for (const profile of profiles) launch(profile);
    await stopped;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function main(): Promise<void> {
  const options = parseSupervisorOptions(process.argv.slice(2));
  const profiles = await loadSupervisorProfiles(options);
  console.log(
    `${timestamp()} supervising ${profiles.length} repository profile${profiles.length === 1 ? "" : "s"}: ${profiles.map((profile) => profile.name).join(", ")}`,
  );
  if (options.mode === "run") await runContinuously(profiles, options.restartSeconds);
  else await runFinite(profiles, options.mode);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
