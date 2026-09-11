import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { collectFinalEvidenceAttachments, type EvidenceRun } from "../src/evidence.js";
import { finalizeEvidence, publishEvidence } from "../src/worker/evidence-flow.js";
import type { WorkerContext } from "../src/worker/shared.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function oversizedGif(): Buffer {
  const buffer = Buffer.alloc(11 * 1024 * 1024);
  buffer.write("GIF89a", 0, "ascii");
  return buffer;
}

async function fixture() {
  const runDir = await mkdtemp(join(tmpdir(), "pi-worker-finalize-"));
  const evidence: EvidenceRun = {
    issueNumber: 42, prNumber: 7, runId: basename(runDir), issueRoot: runDir, runDir, relativeRunDir: ".qa/run",
  };
  const recorded: Array<{ status: string | undefined; detail: string | undefined }> = [];
  const published: string[] = [];
  const ctx = {
    state: {
      recordEvidenceRun: (_issue: number, _pr: number | null, _run: string, status?: string, detail?: string) => {
        recorded.push({ status, detail });
      },
      setEvidenceRunStatus: (_issue: number, _pr: number | null, _run: string, status: string, detail?: string) => {
        recorded.push({ status, detail });
      },
      markProcessed: () => {},
    },
    github: { publishEvidence: async (_pr: number, _sha: string, _run: string, attachments: Array<{ name: string }>) => {
      published.push(...attachments.map((attachment) => attachment.name));
      return "Evidence published";
    } },
    repository: { headRevision: async () => "abc123" },
  } as unknown as WorkerContext;
  return { runDir, evidence, ctx, recorded, published, cleanup: () => rm(runDir, { recursive: true, force: true }) };
}

// iiasa/IIASA.GeoWiki#559 and #526 blocked on the unconditional GIF requirement.
test("a visual run with screenshots but no workflow GIF is valid and notes the omission", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.runDir, "desktop.png"), png);
    await finalizeEvidence(f.ctx, f.evidence);
    assert.equal(f.recorded.at(-1)?.status, "valid");
    assert.match(f.recorded.at(-1)?.detail ?? "", /workflow GIF/i);
  } finally { await f.cleanup(); }
});

// iiasa/IIASA.GeoWiki#558 blocked on an oversized workflow GIF.
test("an oversized workflow GIF is omitted from a valid run and the published note says why", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.runDir, "desktop.png"), png);
    await writeFile(join(f.runDir, "workflow.gif"), oversizedGif());
    const result = await publishEvidence(f.ctx, 7, f.runDir, f.evidence);
    assert.deepEqual(f.published, ["desktop.png"]);
    assert.match(result?.note ?? "", /Evidence published/);
    assert.match(result?.note ?? "", /workflow\.gif/);
    assert.match(result?.note ?? "", /10 MiB/);
    assert.ok(f.recorded.some((entry) => entry.status === "valid"));
  } finally { await f.cleanup(); }
});

// The GIF-attempted note must come from the classification evidence.ts already performed, not from a
// second filename regex in another file that could drift out of sync with it.
test("a skipped attachment reports the media type evidence collection assigned it", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.runDir, "desktop.png"), png);
    await writeFile(join(f.runDir, "workflow.gif"), oversizedGif());
    const skipped: Array<{ name: string; mediaType: string; reason: string }> = [];
    await collectFinalEvidenceAttachments(f.runDir, (skip) => skipped.push(skip));
    assert.deepEqual(skipped.map(({ name, mediaType }) => ({ name, mediaType })), [
      { name: "workflow.gif", mediaType: "image/gif" },
    ]);
  } finally { await f.cleanup(); }
});

test("a visual run without any PNG screenshot is still terminal", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.runDir, "report.md"), "Captured nothing");
    await assert.rejects(finalizeEvidence(f.ctx, f.evidence), /no PNG screenshot/);
    assert.equal(f.recorded.at(-1)?.status, "invalid-terminal");
  } finally { await f.cleanup(); }
});
