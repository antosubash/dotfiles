import { spawn } from "node:child_process";
import type { ExecResult } from "./types.js";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputChars?: number;
}

export async function execFile(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendOutput = (current: string, chunk: string): string => {
      const combined = current + chunk;
      return options.maxOutputChars && combined.length > options.maxOutputChars
        ? combined.slice(-options.maxOutputChars)
        : combined;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout = appendOutput(stdout, chunk)));
    child.stderr.on("data", (chunk: string) => (stderr = appendOutput(stderr, chunk)));
    child.on("error", reject);

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }, options.timeoutMs)
      : null;
    timer?.unref();

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { stdout, stderr, exitCode: code ?? 1 };
      if (timedOut) {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      } else if (result.exitCode !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`.trim(),
          ),
        );
      } else {
        resolve(result);
      }
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await execFile("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    allowFailure: true,
  });
  return result.exitCode === 0;
}
