import type { AgentEvent } from "@earendil-works/pi-durable";
import type { VerificationEvidence } from "../../types.js";
import { toolTargetPath } from "../policy.js";

type ToolEnd = Extract<AgentEvent, { type: "tool_execution_end" }>;
type ToolResultMessage = { isError?: boolean; durationMs?: number; content?: Array<{ type: string; text?: string }> };

/**
 * The tool result an end event carries: the transcript entry of a model call, or the result of a nested call. An end
 * event with neither means the call never finished (its task faulted, or its run or parent settled first), so it
 * counts as an error rather than as a successful run with no output.
 */
function endResult(event: ToolEnd): { isError: boolean; durationMs: number | undefined; text: string } {
  const message = (event.entry?.model as ToolResultMessage[] | undefined)?.[0];
  if (message) {
    const text = message.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
    return { isError: message.isError === true, durationMs: message.durationMs, text };
  }
  if (event.result === undefined) return { isError: true, durationMs: undefined, text: "" };
  const structured = event.result?.structuredOutput as { output?: unknown } | string | undefined;
  const text = typeof structured === "string" ? structured : typeof structured?.output === "string" ? structured.output : "";
  return { isError: event.result?.isError === true, durationMs: event.result?.durationMs, text };
}

export interface RunEventSink {
  /** Feeds one committed batch of agent events. */
  handle(events: readonly AgentEvent[]): void;
  readonly evidence: VerificationEvidence;
}

/**
 * Job-log lines (tool starts, failed or slow tools, run boundaries, retries) and the verifier's evidence (successful
 * bash commands with their output tail, and successfully read paths).
 */
export function createRunEventSink(options: {
  log: (line: string) => Promise<void>;
  worktree: string;
  collectEvidence: boolean;
}): RunEventSink {
  const evidence: VerificationEvidence = { commands: [], readPaths: [] };
  const inputs = new Map<string, { toolName: string; args: { command?: unknown; path?: unknown } }>();
  const log = (line: string) => void options.log(line);
  return {
    evidence,
    handle(events) {
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
            // Resolved the way the read tool and the tool policy resolve it (`@`, `~/`, `file://`), so the receipt names the file read.
            evidence.readPaths.push(toolTargetPath(options.worktree, input.args.path));
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
