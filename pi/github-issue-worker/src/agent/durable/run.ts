import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, ConversationBusy, type Conversation, type Submission } from "@earendil-works/pi-durable";

/** File name of a job's durable session: one SQLite store holding its root conversation, tasks and usage. */
const DURABLE_SESSION_FILE = "harness.sqlite";

/**
 * Where a run keeps its conversation. A previous durable session is reused; anything else (none yet, or a JSONL
 * session from before the durable runtime) gets the session directory's store, which also finds a run a crashed
 * process left behind before the controller recorded its session file.
 */
export function durableSessionPath(sessionDir: string, sessionFile: string | null): string {
  return sessionFile?.endsWith(".sqlite") ? sessionFile : join(sessionDir, DURABLE_SESSION_FILE);
}

/**
 * The request ID of a prompt. The controller re-issues the same prompt after a worker restart, so the same ID
 * reattaches to the run the last process left unfinished (or already answered) instead of starting it twice.
 */
function promptRequestId(prompt: string): string {
  return `worker-run:${createHash("sha256").update(prompt).digest("hex").slice(0, 32)}`;
}

/**
 * Submits the run's prompt. An unfinished run for another prompt belongs to work the controller has since moved
 * past (it reissues the same prompt when it retries), so it is aborted rather than left to run first.
 */
export async function submitPrompt(
  root: Conversation,
  prompt: string,
  context: Context,
  onAbandon: () => void,
): Promise<Submission> {
  const draft = { type: "input", content: prompt, requestId: promptRequestId(prompt), whenBusy: "reject" } as const;
  try {
    return await root.submit(draft, context);
  } catch (error) {
    if (!(error instanceof ConversationBusy)) throw error;
    onAbandon();
    await root.abort(context);
    return await root.submit(draft, context);
  }
}

type AssistantContent = { type: string; text?: string };
type AssistantMessage = { content?: AssistantContent[]; stopReason?: string; errorMessage?: string };

/** The final assistant text of a settled submission, or an error naming why the run produced none. */
export async function settledAnswer(root: Conversation, submission: Submission, context: Context): Promise<string> {
  const settled = await submission.wait(context);
  if (settled.status !== "done" || settled.type !== "input") {
    const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
    throw new Error(`Pi run ended without an answer (${settled.reason ?? settled.status})${detail}`);
  }
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  const message = (entry?.model as AssistantMessage[] | undefined)?.[0];
  if (message?.stopReason === "error" || message?.stopReason === "aborted") {
    throw new Error(message.errorMessage || `Pi stopped with ${message.stopReason}`);
  }
  return (message?.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("").trim();
}
