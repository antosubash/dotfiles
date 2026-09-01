#!/usr/bin/env node
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "./exec.js";

const BRIDGE_IMAGE = "alpine/socat:1.8.0.3";
const RUNTIME_TARGET = "/pi-runtime";
const SOCKET_NAME = "docker-app.sock";

function fail(message: string): never {
  throw new Error(`Docker bridge refused: ${message}`);
}

export function resolvePrivateRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.(),
): string {
  if (uid === undefined) fail("a numeric Linux user ID is required");
  const configured = environment.CLAUDE_CODE_TMPDIR || environment.TMPDIR;
  if (!configured) fail("CLAUDE_CODE_TMPDIR or TMPDIR is required");
  const expectedRoot = `/run/user/${uid}`;
  const runtime = realpathSync(resolve(configured));
  if (dirname(runtime) !== expectedRoot || !basename(runtime).startsWith("piw-")) {
    fail(`runtime must be a piw-* directory directly beneath ${expectedRoot}`);
  }
  const info = lstatSync(runtime);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    fail("runtime must be a private, user-owned, mode-0700 directory");
  }
  return runtime;
}

function safeDockerName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)) {
    fail(`${label} contains unsupported characters`);
  }
  return value;
}

export function bridgeArguments(args: readonly string[]): {
  action: "start" | "stop";
  network?: string;
  host?: string;
  port?: number;
} {
  const [action, network, host, rawPort, ...extra] = args;
  if (action === "stop" && !network && !host && !rawPort && extra.length === 0) {
    return { action };
  }
  if (action !== "start" || !network || !host || !rawPort || extra.length > 0) {
    fail("usage: pi-worker-docker-bridge start <docker-network> <service-host> <port> | stop");
  }
  const safeNetwork = safeDockerName(network, "network");
  if (["host", "none", "bridge", "default"].includes(safeNetwork.toLowerCase())) {
    fail("a dedicated application Docker network is required");
  }
  const safeHost = safeDockerName(host, "service host");
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isSafeInteger(port) || String(port) !== rawPort || port < 1 || port > 65_535) {
    fail("port must be an integer from 1 to 65535");
  }
  return { action, network: safeNetwork, host: safeHost, port };
}

function bridgeContainerName(runtime: string): string {
  return `piw-bridge-${basename(runtime).replace(/[^A-Za-z0-9_.-]/g, "-")}`.slice(0, 63);
}

async function removeOwnedBridge(containerName: string, runtime: string): Promise<void> {
  const inspected = await execFile(
    "docker",
    ["inspect", "--format", "{{ index .Config.Labels \"org.pi-worker.runtime\" }}", containerName],
    { allowFailure: true, timeoutMs: 60_000 },
  );
  if (inspected.exitCode !== 0) return;
  if (inspected.stdout.trim() !== basename(runtime)) {
    fail(`container name collision for ${containerName}`);
  }
  await execFile("docker", ["rm", "-f", containerName], { timeoutMs: 60_000 });
}

async function main(): Promise<void> {
  const runtime = resolvePrivateRuntime();
  const options = bridgeArguments(process.argv.slice(2));
  const containerName = bridgeContainerName(runtime);
  if (options.action === "stop") {
    await removeOwnedBridge(containerName, runtime);
    return;
  }
  await removeOwnedBridge(containerName, runtime);
  await execFile(
    "docker",
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      containerName,
      "--label",
      `org.pi-worker.runtime=${basename(runtime)}`,
      "--network",
      options.network!,
      "--volume",
      `${runtime}:${RUNTIME_TARGET}`,
      BRIDGE_IMAGE,
      `UNIX-LISTEN:${RUNTIME_TARGET}/${SOCKET_NAME},fork,mode=0666`,
      `TCP:${options.host}:${options.port}`,
    ],
    { timeoutMs: 120_000 },
  );
  process.stdout.write(`${resolve(runtime, SOCKET_NAME)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
