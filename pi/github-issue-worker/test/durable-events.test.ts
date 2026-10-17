import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { createRunEventSink } from "../src/agent/durable/events.js";

const start = (toolCallId: string, toolName: string, args: Record<string, unknown>) =>
  ({ type: "tool_execution_start", toolCallId, toolName, args }) as unknown as AgentEvent;
const end = (toolCallId: string, toolName: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool_execution_end", toolCallId, toolName, ...extra }) as unknown as AgentEvent;
const nested = (isError: boolean, output: string) => ({ result: { isError, structuredOutput: { output } } });

test("only calls that finished successfully become verifier evidence", () => {
  const sink = createRunEventSink({ log: async () => undefined, worktree: "/work", collectEvidence: true });
  sink.handle([
    start("a", "bash", { command: "npm test" }), end("a", "bash", nested(false, "ok")),
    start("b", "bash", { command: "npm run lint" }), end("b", "bash", nested(true, "failed")),
    // A nested call whose parent settled first ends with neither a result nor an entry: it never completed.
    start("c", "bash", { command: "npm run build" }), end("c", "bash"),
    start("d", "read", { path: "report.txt" }), end("d", "read", nested(false, "")),
    start("e", "read", { path: "never-read.txt" }), end("e", "read"),
  ]);
  assert.deepEqual(sink.evidence.commands, [{ command: "npm test", output: "ok" }]);
  assert.deepEqual(sink.evidence.readPaths, ["/work/report.txt"]);
});
