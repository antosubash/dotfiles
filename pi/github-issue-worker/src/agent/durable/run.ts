import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, ConversationBusy, type Conversation, type EntryId, type Submission, type SubmissionRecord } from "@earendil-works/pi-durable";

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

type AssistantContent = { type: string; text?: string };
type AssistantMessage = { content?: AssistantContent[]; stopReason?: string; errorMessage?: string };

/** The assistant message of an answer entry. */
async function answerMessage(root: Conversation, answer: EntryId, context: Context): Promise<AssistantMessage | undefined> {
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, answer), context);
  return (entry?.model as AssistantMessage[] | undefined)?.[0];
}

const failedStop = (message: AssistantMessage | undefined) => message?.stopReason === "error" || message?.stopReason === "aborted";

/** Whether a submission already ended without a usable answer: it was withdrawn or aborted, or its answer is an error. */
async function endedInFailure(root: Conversation, record: SubmissionRecord, context: Context): Promise<boolean> {
  if (record.type !== "input") return false;
  if (record.status === "unanswered") return true;
  return record.status === "done" && failedStop(await answerMessage(root, record.answer, context));
}

/**
 * Submits the run's prompt. An unfinished run for another prompt belongs to work the controller has since moved
 * past (it reissues the same prompt when it retries), so it is aborted rather than left to run first. A request ID
 * names its submission for good, so a prompt whose earlier run was aborted or ended in an error is submitted again under
 * a fresh ID: the controller's retry gets a new run instead of the old failure.
 *
 * An already answered run is reattached only when the controller never recorded this store (`recorded` false): then the
 * last process died between the answer and the controller saving it. Once the store is recorded the controller has
 * received every earlier answer, so an identical prompt is a retry (after a BLOCKED answer, or a result a later stage
 * rejected) and gets a new run instead of the stale answer. A crash between an answer and the controller recording it
 * for a later round reruns the agent, which is repeated work but never a stale result.
 */
export async function submitPrompt(
  root: Conversation,
  prompt: string,
  context: Context,
  onAbandon: () => void,
  recorded = false,
): Promise<Submission> {
  const base = promptRequestId(prompt);
  for (let attempt = 0; ; attempt++) {
    const draft = { type: "input", content: prompt, requestId: attempt === 0 ? base : `${base}:retry-${attempt}`, whenBusy: "reject" } as const;
    let submission: Submission;
    try {
      submission = await root.submit(draft, context);
    } catch (error) {
      if (!(error instanceof ConversationBusy)) throw error;
      onAbandon();
      await root.abort(context);
      submission = await root.submit(draft, context);
    }
    const record = await submission.status(context);
    if (!(recorded && record.status === "done") && !(await endedInFailure(root, record, context))) return submission;
  }
}

/** The final assistant text of a settled submission, or an error naming why the run produced none. */
export async function settledAnswer(root: Conversation, submission: Submission, context: Context): Promise<string> {
  const settled = await submission.wait(context);
  if (settled.status !== "done" || settled.type !== "input") {
    const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
    throw new Error(`Pi run ended without an answer (${settled.reason ?? settled.status})${detail}`);
  }
  const message = await answerMessage(root, settled.answer, context);
  if (message && failedStop(message)) throw new Error(message.errorMessage || `Pi stopped with ${message.stopReason}`);
  return (message?.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("").trim();
}
