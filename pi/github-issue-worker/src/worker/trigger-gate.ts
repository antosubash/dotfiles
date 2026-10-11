import { TooManyEditsError, type TrustService } from "../github/trust.js";
import { issueHash } from "../issue-plan.js";
import { errorText, type WorkerContext } from "./shared.js";

interface TriggerItem { number: number; title: string; body: string; author?: { login: string } | null }
type TriggerResult = { ok: true; hash: string } | { ok: false; reason: string };

/** Only text written, edited and approved by users with write access, unchanged since approval, may start a run. */
export async function checkTrigger(trust: TrustService, item: TriggerItem, label: string): Promise<TriggerResult> {
  const author = item.author?.login ?? null;
  if (!author || !(await trust.canWrite(author))) {
    return { ok: false, reason: `the author \`${author ?? "unknown"}\` doesn't have write access. A maintainer can re-file it` };
  }
  const approval = await trust.approval(item.number, label);
  if (!approval.labeledBy || !approval.labeledAt) return { ok: false, reason: `no \`${label}\` label event was found` };
  if (!(await trust.canWrite(approval.labeledBy))) {
    return { ok: false, reason: `\`${label}\` was added by \`${approval.labeledBy}\`, who doesn't have write access` };
  }
  let bodyEdits;
  try {
    bodyEdits = await trust.bodyEdits(item.number);
  } catch (error) {
    if (error instanceof TooManyEditsError) return { ok: false, reason: "it has too many edits to verify" };
    throw error;
  }
  for (const edit of [...approval.renames, ...bodyEdits]) {
    if (edit.editedAt > approval.labeledAt) {
      return { ok: false, reason: `it was edited after \`${label}\` was added. Review the changes and add \`${label}\` again` };
    }
    if (!edit.editor || !(await trust.canWrite(edit.editor))) {
      return { ok: false, reason: `it was edited by \`${edit.editor ?? "a deleted account"}\`, who doesn't have write access` };
    }
  }
  return { ok: true, hash: issueHash(item) };
}

export type Admission = { status: "admitted"; hash: string } | { status: "rejected" } | { status: "deferred" };

/**
 * Admitted carries the content hash to pin on the job. A rejection removes the labels and comments once.
 * Deferred (a transient error, including a failed rejection) changes nothing, so the next poll retries.
 */
export async function admitTrigger(ctx: WorkerContext, item: TriggerItem, label: string): Promise<Admission> {
  try {
    const result = await checkTrigger(ctx.trust, item, label);
    if (result.ok) return { status: "admitted", hash: result.hash };
    await ctx.github.rejectTrigger(item.number, label, `⛔ Not started: ${result.reason}.`);
    return { status: "rejected" };
  } catch (error) {
    console.error(`${new Date().toISOString()} trigger check for #${item.number} deferred: ${errorText(error)}`);
    return { status: "deferred" };
  }
}
