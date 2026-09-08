import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { WorkerConfig } from "./config.js";
import { execFile } from "./exec.js";
import type { IssuePlan } from "./issue-plan.js";
import type { PiAgentRunner } from "./pi-agent.js";
import { buildFigmaVerificationPrompt, DESIGN_CHECKS } from "./prompts.js";
export { DESIGN_CHECKS } from "./prompts.js";
import { loadQaManifest } from "./qa-manifest.js";
import type { GitHubIssue, VerificationEvidence } from "./types.js";

export function assertBrowserExecution(paths: string[], evidence: VerificationEvidence | undefined): void {
  if (!evidence || !evidence.commands.some((entry) => /\bplaywright-cli\b[^\n]*\bscreenshot\b/.test(entry.command)) ||
      !paths.every((path) => evidence.readPaths.includes(resolve(path)))) {
    throw new Error("Browser verification requires runner-recorded screenshot commands and image reads, not just claimed files.");
  }
}

export interface FigmaTarget { url: string; fileKey: string; nodeId: string }
export interface FigmaReference extends FigmaTarget { directory: string; version: string }

/** Extract exact Figma hosts, including bare links and Markdown destinations. Never request supplied URLs. */
export function figmaTargets(text: string): FigmaTarget[] {
  const targets = new Map<string, FigmaTarget>();
  const links = text.matchAll(/(?:https?:\/\/[^\s<>"'`]+|(?<![\w@./-])(?:www\.)?figma\.com\/[^\s<>"'`]+)/gi);
  for (const match of links) {
    const raw = match[0].replace(/[)\]},.!;]+$/, "").replaceAll("&amp;", "&");
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
    catch {
      if (/^(?:https?:\/\/)?(?:www\.)?figma\.com(?:[/:?#]|$)/i.test(raw)) {
        throw new Error("Figma verification BLOCKED: malformed Figma URL.");
      }
      continue;
    }
    if (!["figma.com", "www.figma.com"].includes(url.hostname)) continue;
    const parts = url.pathname.split("/").filter(Boolean);
    const fileKey = parts[2] === "branch" ? parts[3] : parts[1];
    const nodeId = url.searchParams.get("node-id")?.replaceAll("-", ":");
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["design", "file", "proto", "board"].includes(parts[0] ?? "") ||
        !fileKey || !/^[A-Za-z0-9]{1,128}$/.test(fileKey) ||
        !nodeId || !/^I?\d+:\d+(?:;\d+:\d+)*$/.test(nodeId)) {
      throw new Error("Figma verification BLOCKED: supply an HTTPS file/frame link with an explicit node-id (Make and ambiguous file-only links are unsupported).");
    }
    const canonical = `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId)}`;
    targets.set(canonical, { url: canonical, fileKey, nodeId });
  }
  if (targets.size > 10) throw new Error("Figma verification BLOCKED: select at most 10 design frames per issue.");
  return [...targets.values()];
}

export async function regularFile(root: string, path: string, limit: number): Promise<Buffer> {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || await realpath(absolute) !== absolute) {
    throw new Error("Figma evidence must be inside its assigned directory without symlinks.");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error("Invalid or oversized Figma evidence file.");
  return readFile(absolute);
}

/** Fingerprint actual source, including dirty/untracked files, not just HEAD or filenames. */
export async function sourceFingerprint(worktree: string): Promise<string> {
  const hash = createHash("sha256");
  for (const args of [["rev-parse", "HEAD"], ["ls-files", "--stage", "-z"]]) {
    hash.update((await execFile("git", args, { cwd: worktree })).stdout);
  }
  const files = (await execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: worktree })).stdout;
  for (const path of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    hash.update(`\0${path}\0`);
    const absolute = join(worktree, path);
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) { hash.update("deleted"); continue; }
    hash.update(String(info.mode));
    if (info.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (info.isFile()) {
      // Refuse symlinked parents rather than reading outside the worktree.
      if (await realpath(absolute) !== absolute) throw new Error("Source fingerprint encountered a symlinked parent.");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    } else throw new Error("Figma verification cannot fingerprint a submodule or special source file.");
  }
  return hash.digest("hex");
}

export async function validateDesignResult(text: string, references: FigmaReference[], evidenceDir: string, planCheckIds: string[] = []): Promise<unknown> {
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("Figma verifier returned no valid JSON verdict."); }
  if (result?.status !== "passed" || !Array.isArray(result.frames) || result.frames.length !== references.length) {
    throw new Error(`Figma verification ${result?.status === "failed" ? "FAILED" : "BLOCKED"}: incomplete or unsuccessful frame coverage. ${String(result?.summary ?? "").slice(0, 1000)}`);
  }
  if (planCheckIds.length && (!Array.isArray(result.planChecks) ||
      result.planChecks.some((check: { status?: string }) => check?.status !== "passed") ||
      new Set(result.planChecks.map((check: { id?: string }) => check?.id)).size !== result.planChecks.length ||
      !planCheckIds.every((id) => result.planChecks.some((check: { id?: string; status?: string; notes?: string }) =>
        check?.id === id && check.status === "passed" && typeof check.notes === "string" && check.notes.trim())))) {
    throw new Error("Figma verifier did not verify every design check in pi-plan.");
  }
  const seen = new Set<string>();
  for (const reference of references) {
    const frame = result.frames.find((item: { url?: string }) => item?.url === reference.url);
    if (!frame || seen.has(frame.url) || frame.version !== reference.version || frame.status !== "passed" ||
        typeof frame.appUrl !== "string" || !/^https?:\/\//.test(frame.appUrl) ||
        !frame.viewport || !Number.isInteger(frame.viewport.width) || frame.viewport.width < 1 ||
        !Number.isInteger(frame.viewport.height) || frame.viewport.height < 1 ||
        !DESIGN_CHECKS.every((check) => frame.checks?.[check]?.status === "passed" &&
          typeof frame.checks[check].notes === "string" && frame.checks[check].notes.trim().length > 0) ||
        !Array.isArray(frame.screenshots) || frame.screenshots.length === 0) {
      throw new Error("Figma verifier omitted frame identity, viewport, or required design comparisons.");
    }
    seen.add(frame.url);
    for (const screenshot of frame.screenshots) {
      if (typeof screenshot !== "string" || !screenshot.endsWith(".png")) throw new Error("Figma verifier omitted PNG evidence.");
      const bytes = await regularFile(evidenceDir, screenshot, 50 * 1024 * 1024);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== frame.viewport.width ||
          bytes.readUInt32BE(20) !== frame.viewport.height) {
        throw new Error("Figma verifier supplied invalid PNG evidence or inconsistent viewport dimensions.");
      }
      if (bytes.equals(await regularFile(reference.directory, "reference.png", 50 * 1024 * 1024))) {
        throw new Error("Figma reference image is not application screenshot evidence.");
      }
    }
  }
  return result;
}

/** Controller-owned service; no implementation conversation, no credential access for the model. */
export class FigmaVerificationService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly agent: Pick<PiAgentRunner, "run">,
    private readonly run: typeof execFile = execFile,
  ) {}

  async verify(issue: GitHubIssue, worktree: string, plan: IssuePlan | null = null): Promise<string | null> {
    const targets = figmaTargets(`${issue.title}\n${issue.body}`);
    const designChecks = plan?.checks.filter((check) => check.kind === "design") ?? [];
    if (targets.length === 0) {
      if (designChecks.length) throw new Error("pi-plan requires design verification but the issue has no Figma frame link.");
      return null;
    }
    // Operator-installed CLI, never code selected from the untrusted issue worktree.
    const cli = await realpath(join(this.config.agentDir, "skills/figma/scripts/figma.py"))
      .catch(() => { throw new Error("Figma verification BLOCKED: install the figma skill in PI_WORKER_AGENT_DIR."); });
    const root = join(this.config.dataDir, "figma", `issue-${issue.number}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const references: FigmaReference[] = [];
    for (const target of targets) {
      const key = createHash("sha256").update(target.url).digest("hex");
      const parent = join(root, "designs", key);
      const directory = join(parent, "bundle");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory).catch(() => null))) {
        const fetched = await this.run("python3", ["-I", "-B", cli, "fetch", target.url, "--out", directory], {
          cwd: worktree, timeoutMs: 120_000, maxOutputChars: 4000, allowFailure: true,
        });
        if (fetched.exitCode !== 0) {
          // CLI errors are sanitized; never log response JSON/signed asset URLs.
          throw new Error(`Figma verification BLOCKED: ${fetched.stderr.trim() || "design fetch failed"}`);
        }
      }
      const manifest = JSON.parse((await regularFile(directory, "manifest.json", 1024 * 1024)).toString());
      if (manifest.complete !== true || manifest.fileKey !== target.fileKey || manifest.nodeId !== target.nodeId ||
          typeof manifest.version !== "string" || !manifest.version) {
        throw new Error("Figma verification BLOCKED: incomplete or mismatched cached design. Inspect the local cache before deliberately retrying.");
      }
      for (const name of ["design.json", "summary.json", "reference.png"]) await regularFile(directory, name, 50 * 1024 * 1024);
      references.push({ ...target, directory, version: manifest.version });
    }
    const runDir = join(root, "runs", randomUUID());
    const evidenceDir = join(runDir, "evidence");
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const before = await sourceFingerprint(worktree);
    const reportPath = join(runDir, "result.json");
    try {
      const result = await this.agent.run({
        worktree,
        sessionDir: join(runDir, "sessions"), sessionFile: null,
        logFile: join(runDir, "agent.log"), visualVerification: true, dockerAccess: false,
        verification: { readPaths: references.map((item) => item.directory), evidenceDir },
        prompt: buildFigmaVerificationPrompt({
          config: this.config, issue, references, evidenceDir, designChecks,
          qaManifest: await loadQaManifest(worktree, this.config.qaManifestPath),
        }),
      });
      await writeFile(join(runDir, "verdict.txt"), result.finalText, { mode: 0o600, flag: "wx" });
      if (await sourceFingerprint(worktree) !== before) throw new Error("Figma verifier changed source; verification is invalid. Only the implementation worker may fix code.");
      const verdict = await validateDesignResult(result.finalText, references, evidenceDir, designChecks.map((check) => check.id));
      const frames = (verdict as { frames: Array<{ screenshots: string[] }> }).frames;
      assertBrowserExecution([
        ...references.flatMap((reference) => [join(reference.directory, "reference.png"), join(reference.directory, "summary.json")]),
        ...frames.flatMap((frame) => frame.screenshots.map((path) => resolve(evidenceDir, path))),
      ], result.verificationEvidence);
      await writeFile(reportPath, JSON.stringify({ status: "passed", sourceFingerprint: before, references, verdict, execution: result.verificationEvidence }, null, 2), { mode: 0o600, flag: "wx" });
      return reportPath;
    } catch (error) {
      await writeFile(reportPath, JSON.stringify({ status: "blocked", sourceFingerprint: before, error: String(error) }, null, 2), { mode: 0o600, flag: "wx" });
      throw new Error(`Figma design gate: ${error instanceof Error ? error.message : "verification failed"}. Local report: ${reportPath}`);
    }
  }
}
