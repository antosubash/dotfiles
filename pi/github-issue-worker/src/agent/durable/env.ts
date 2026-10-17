import type { Context } from "@earendil-works/chord";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { err, ExecutionError, ok, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** POSIX single-quote one argv entry so an argv call keeps its exact arguments through `bash -c`. */
function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

function executionError(error: unknown): ExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "aborted") return new ExecutionError("aborted", "Command aborted");
  if (message.startsWith("timeout:")) return new ExecutionError("timeout", `Command timed out after ${message.slice(8)} seconds`);
  return new ExecutionError("unknown", message, error instanceof Error ? error : undefined);
}

/**
 * The durable harness's execution environment for one worker run: files are read and written locally (the tool
 * policy hook has already confined paths to the worktree), and every command — the `bash` tool, codemode's nested
 * calls, and the argv calls of `grep`/`find` — runs through the isolation's bash operations, so the process-group
 * tracking, child cgroup, credential scrub, optional OS sandbox and leftover-process check apply unchanged.
 */
export class IsolatedExecutionEnv extends NodeExecutionEnv {
  constructor(cwd: string, private readonly bash: BashOperations) {
    super({ cwd });
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const script = typeof command === "string" ? command : command.map(shellQuote).join(" ");
    const decoder = new TextDecoder();
    const onOutput = options?.onOutput;
    try {
      const { exitCode } = await this.bash.exec(script, options?.cwd ?? this.cwd, {
        onData: (data) => {
          const text = decoder.decode(data, { stream: true });
          if (text) onOutput?.(text, context, { stream: "stdout" });
        },
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.env ? { env: options.env } : {}),
      });
      const tail = decoder.decode();
      if (tail) onOutput?.(tail, context, { stream: "stdout" });
      return ok({ exitCode: exitCode ?? 1 });
    } catch (error) {
      return err(executionError(error));
    }
  }
}
