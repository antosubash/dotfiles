import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { WorkerConfig } from "../config.js";
import type { VerificationOptions } from "./policy.js";

function packageRootFromModule(moduleUrl: string): string {
  let current = dirname(fileURLToPath(moduleUrl));
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Unable to locate worker package root from ${moduleUrl}`);
    current = parent;
  }
}

const WORKER_RUNTIME_ROOT = packageRootFromModule(import.meta.url);

const STALE_SANDBOX_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;

export function sandboxTempRoot(visualVerification: boolean): string {
  if (!visualVerification || process.platform !== "linux") return "/tmp";
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Visual sandbox requires a numeric Linux user ID");
  const root = `/run/user/${uid}`;
  try {
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`Visual sandbox requires a private writable runtime directory at ${root}`);
  }
  return root;
}

export async function removeStaleSandboxTemps(
  root = "/tmp",
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const currentUid = process.getuid?.();
  await Promise.all(
    entries
      .filter((entry) => entry.name.startsWith("piw-"))
      .map(async (entry) => {
        const path = join(root, entry.name);
        const info = await lstat(path).catch(() => null);
        if (!info || (currentUid !== undefined && info.uid !== currentUid)) return;
        if (now - info.mtimeMs < STALE_SANDBOX_TEMP_AGE_MS) return;
        const ownerPid = Number.parseInt(
          await readFile(join(path, ".owner-pid"), "utf8").catch(() => ""),
          10,
        );
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
          try {
            process.kill(ownerPid, 0);
            return;
          } catch (error) {
            const code = error instanceof Error && "code" in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
            if (code === "EPERM") return;
          }
        }
        await rm(path, { recursive: true, force: true });
      }),
  );
}

function gitMetadataPaths(worktree: string): string[] {
  const gitFile = resolve(worktree, ".git");
  if (!existsSync(gitFile)) return [];
  if (lstatSync(gitFile).isDirectory()) return [gitFile];
  const contents = readFileSync(gitFile, "utf8").trim();
  const match = contents.match(/^gitdir:\s*(.+)$/im);
  if (!match) return [];
  const gitDir = resolve(worktree, match[1]!);
  return [gitDir, resolve(gitDir, "..", "..")];
}

export function sandboxConfig(
  worktree: string,
  config: WorkerConfig,
  options: {
    privateTemp?: string;
    visualVerification?: boolean;
    dockerSocket?: string | null;
    verification?: VerificationOptions;
  } = {},
): SandboxRuntimeConfig {
  const home = resolve(process.env.HOME || homedir());
  const privateTemp = resolve(options.privateTemp || "/tmp");
  if (options.verification && privateTemp === "/tmp") {
    throw new Error("Verifier requires a private temporary directory, not shared /tmp.");
  }
  const pathReadPaths = (process.env.PATH || "")
    .split(":")
    .filter((path) => path.startsWith(`${home}/`))
    .map((path) => resolve(path));
  const visualVerification = options.visualVerification === true;
  const playwrightBrowserPath = resolve(
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
      (process.platform === "darwin"
        ? join(home, "Library", "Caches", "ms-playwright")
        : join(home, ".cache", "ms-playwright")),
  );
  const playwrightFfmpegPaths = visualVerification && existsSync(playwrightBrowserPath)
    ? readdirSync(playwrightBrowserPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("ffmpeg-"))
        .map((entry) => join(playwrightBrowserPath, entry.name))
    : [];
  const readPaths = [
    ...new Set([
      worktree,
      privateTemp,
      WORKER_RUNTIME_ROOT,
      ...gitMetadataPaths(worktree),
      ...pathReadPaths,
      ...playwrightFfmpegPaths,
      ...(options.verification ? [...options.verification.readPaths, options.verification.evidenceDir] : []),
      ...(options.dockerSocket ? [options.dockerSocket] : []),
    ]),
  ];
  const socketAccessRequested = visualVerification || Boolean(options.dockerSocket);
  const linuxSocketAccess = socketAccessRequested && process.platform === "linux";
  const hiddenRunEntries = linuxSocketAccess
    ? [
        ...readdirSync("/run", { withFileTypes: true })
          .filter((entry) => entry.name !== "user" && !entry.isSymbolicLink())
          .map((entry) => resolve("/run", entry.name))
          .filter((path) => path !== options.dockerSocket),
        ...readdirSync("/run/user", { withFileTypes: true })
          .filter(
            (entry) =>
              !entry.isSymbolicLink() &&
              resolve("/run/user", entry.name) !== dirname(privateTemp),
          )
          .map((entry) => resolve("/run/user", entry.name)),
        ...readdirSync(dirname(privateTemp), { withFileTypes: true })
          .filter((entry) => !entry.isSymbolicLink())
          .map((entry) => resolve(dirname(privateTemp), entry.name))
          .filter((path) => path !== privateTemp && path !== options.dockerSocket),
      ]
    : [];
  const visualSocketPolicy = socketAccessRequested
    ? process.platform === "linux"
      ? { allowAllUnixSockets: true }
      : {
          allowUnixSockets: [
            ...(visualVerification ? [privateTemp] : []),
            ...(options.dockerSocket ? [options.dockerSocket] : []),
          ],
        }
    : {};
  return {
    network: {
      allowedDomains: [...config.sandboxAllowedDomains],
      deniedDomains: [],
      allowLocalBinding: true,
      ...visualSocketPolicy,
    },
    filesystem: {
      denyRead: [
        home,
        ...hiddenRunEntries,
        ...(linuxSocketAccess ? ["/tmp", "/var"] : []),
      ],
      allowRead: readPaths,
      allowWrite: [
        ...(options.verification ? [options.verification.evidenceDir] : [worktree]),
        ...(linuxSocketAccess || options.verification ? [privateTemp] : ["/tmp"]),
        ...(options.dockerSocket ? [options.dockerSocket] : []),
      ],
      denyWrite: [
        ...(options.verification ? [worktree, ...gitMetadataPaths(worktree)] : []),
        resolve(home, ".ssh"),
        resolve(home, ".aws"),
        resolve(home, ".gnupg"),
        resolve(home, ".config"),
      ],
    },
  };
}

export function assertVisualSandboxIsolation(wrappedCommand: string): void {
  if (!/\bbwrap\b/.test(wrappedCommand) || !/--unshare-net\b/.test(wrappedCommand)) {
    throw new Error("Visual sandbox must use an isolated Linux network namespace");
  }
  for (const path of ["/tmp", "/var"]) {
    if (!wrappedCommand.includes(`--tmpfs ${path}`)) {
      throw new Error(`Visual sandbox must hide host socket directory ${path}`);
    }
  }
}

export function sandboxEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !/(?:TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
}

/**
 * Point every per-run scratch location at the private temp directory. `PLAYWRIGHT_MCP_OUTPUT_DIR` matters
 * once the OS sandbox is off: playwright-cli otherwise creates `.playwright-cli/` in its cwd — the worktree —
 * where it is untracked source to the verifier's fingerprint and to the controller's staging. (Under the
 * sandbox the read-only worktree made the CLI fall back to TMPDIR on its own, which is why this never
 * surfaced before.)
 */
export function applySandboxTempEnvironment(sandboxTemp: string, privateTmpdir: boolean): () => void {
  const previous = {
    CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR,
    TMPDIR: process.env.TMPDIR,
    PLAYWRIGHT_DAEMON_SESSION_DIR: process.env.PLAYWRIGHT_DAEMON_SESSION_DIR,
    PLAYWRIGHT_MCP_OUTPUT_DIR: process.env.PLAYWRIGHT_MCP_OUTPUT_DIR,
  };
  process.env.CLAUDE_CODE_TMPDIR = sandboxTemp;
  process.env.PLAYWRIGHT_DAEMON_SESSION_DIR = join(sandboxTemp, "playwright-daemon");
  process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = join(sandboxTemp, "playwright-cli");
  if (privateTmpdir) process.env.TMPDIR = sandboxTemp;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
