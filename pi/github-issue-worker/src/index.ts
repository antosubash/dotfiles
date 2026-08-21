#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { commandExists } from "./exec.js";
import { WorkerState } from "./state.js";
import { IssueWorker } from "./worker.js";
import { ProfileLock } from "./lock.js";

async function requireCommands(commands: readonly string[]): Promise<void> {
  const missing: string[] = [];
  for (const command of commands) {
    if (!(await commandExists(command))) missing.push(command);
  }
  if (missing.length > 0) throw new Error(`Missing required commands: ${missing.join(", ")}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  await requireCommands(["git", "gh"]);
  await mkdir(config.dataDir, { recursive: true });
  const lock = await ProfileLock.acquire(config.dataDir);
  let state: WorkerState | null = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    state = new WorkerState(join(config.dataDir, "state.sqlite"));
    const worker = new IssueWorker(config, state);
    if (process.argv.includes("--check")) {
      await worker.check();
      console.log(`Ready: ${config.repository} (${config.baseBranch})`);
      return;
    }
    await worker.initialize();
    const once = process.argv.includes("--once");
    do {
      const started = Date.now();
      try {
        await worker.tick();
      } catch (error) {
        console.error(`${new Date().toISOString()} worker tick failed`, error);
      }
      if (once || stopping) break;
      const elapsed = Date.now() - started;
      const delay = Math.max(1_000, config.pollSeconds * 1_000 - elapsed);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          process.off("SIGINT", done);
          process.off("SIGTERM", done);
          resolve();
        };
        const timer = setTimeout(done, delay);
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    } while (!stopping);
  } finally {
    state?.close();
    await lock.release();
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
