import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { VerificationEvidence } from "../../types.js";

type ToolEnd = Extract<AgentEvent, { type: "tool_execution_end" }>;
type ToolResultMessage = { isError?: boolean; durationMs?: number; content?: Array<{ type: string; text?: string }> };

/** The tool result an end event carries: the transcript entry of a model call, or the result of a nested call. */
function endResult(event: ToolEnd): { isError: boolean; durationMs: number | undefined; text: string } {
  const message = (event.entry?.model as ToolResultMessage[] | undefined)?.[0];
  if (message) {
    const text = message.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
    return { isError: message.isError === true, durationMs: message.durationMs, text };
  }
  const structured = event.result?.structuredOutput as { output?: unknown } | string | undefined;
  const text = typeof structured === "string" ? structured : typeof structured?.output === "string" ? structured.output : "";
  return { isError: event.result?.isError === true, durationMs: event.result?.durationMs, text };
}

export interface RunEventSink {
  /** Feeds one committed batch of agent events. */
  handle(events: readonly AgentEvent[]): void;
  readonly evidence: VerificationEvidence;
  /** Milliseconds since the last event: the stall detector's input. */
  idleMs(): number;
}

/**
 * Job-log lines (tool starts, failed or slow tools, run boundaries, retries), the verifier's evidence (successful bash
 * commands with their output tail, and successfully read paths), and a progress clock for the stall detector.
 */
export function createRunEventSink(options: { logFile: string; worktree: string; collectEvidence: boolean }): RunEventSink {
  const evidence: VerificationEvidence = { commands: [], readPaths: [] };
  const inputs = new Map<string, { toolName: string; args: { command?: unknown; path?: unknown } }>();
  let lastEvent = Date.now();
  const log = (line: string) => void appendFile(options.logFile, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
  return {
    evidence,
    idleMs: () => Date.now() - lastEvent,
    handle(events) {
      lastEvent = Date.now();
      for (const event of events) {
        if (event.type === "tool_execution_start") {
          inputs.set(event.toolCallId, { toolName: event.toolName, args: event.args as { command?: unknown; path?: unknown } });
          log(`tool ${event.toolName}${event.parentToolCallId ? " (codemode)" : ""}`);
        } else if (event.type === "tool_execution_end") {
          const input = inputs.get(event.toolCallId);
          inputs.delete(event.toolCallId);
          const { isError, durationMs, text } = endResult(event);
          if (isError || (durationMs ?? 0) >= 60_000) {
            const took = durationMs === undefined ? "" : ` ${(durationMs / 1000).toFixed(1)}s`;
            log(`tool_end ${event.toolName}${took}${isError ? " error" : ""}`);
          }
          if (!options.collectEvidence || isError || !input) continue;
          if (input.toolName === "bash" && typeof input.args.command === "string") {
            evidence.commands.push({ command: input.args.command, output: text.slice(-32_000) });
          } else if (input.toolName === "read" && typeof input.args.path === "string") {
            evidence.readPaths.push(resolve(options.worktree, input.args.path.replace(/^@/, "")));
          }
        } else if (event.type === "run_end") {
          log("agent_settled");
        } else if (event.type === "auto_retry_start") {
          log("agent_end retry=true");
        }
      }
    },
  };
}
