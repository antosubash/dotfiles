import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "./config.js";

export const MEMORY_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
export const MEMORY_FILE_BYTES = 4096;
export const MEMORY_FILES = 40;
export const MEMORY_INDEX_BYTES = 6144;

const SECRET =
  /gh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+\S+|password\s*[:=]|\bcookie:|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/i;

/** Per profile, i.e. per repository: notes outside every worktree that survive from one run to the next. */
export function memoryDirectory(config: Pick<WorkerConfig, "dataDir">): string {
  return join(config.dataDir, "memory");
}

export function looksLikeSecret(text: string): boolean {
  return SECRET.test(text);
}

export interface MemoryIndex {
  dir: string;
  /** One entry per note: `- <file> — <title>` plus up to two indented body lines. Empty when there are none. */
  text: string;
  /** Files ignored for their name, size or secret-looking content; they are never rendered. */
  skipped: string[];
}

/** Title + first two body lines of every valid note, newest first, within the byte and file caps. */
export async function projectMemoryIndex(dir: string): Promise<MemoryIndex> {
  const skipped: string[] = [];
  const notes: Array<{ name: string; mtime: number; title: string; lines: string[] }> = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!MEMORY_FILE.test(name)) {
      skipped.push(name);
      continue;
    }
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > MEMORY_FILE_BYTES) {
      skipped.push(name);
      continue;
    }
    const content = await readFile(path, "utf8");
    if (looksLikeSecret(content)) {
      skipped.push(name);
      continue;
    }
    const [first = "", ...rest] = content.split("\n");
    const title = first.replace(/^#\s*/, "").trim() || name;
    notes.push({ name, mtime: info.mtimeMs, title, lines: rest.filter((line) => line.trim()).slice(0, 2) });
  }
  notes.sort((a, b) => b.mtime - a.mtime);
  let text = "";
  for (const note of notes.slice(0, MEMORY_FILES)) {
    const body = note.lines.map((line) => `  ${line}`).join("\n");
    const entry = `- ${note.name} — ${note.title}\n${body ? `${body}\n` : ""}`;
    if (Buffer.byteLength(text + entry) > MEMORY_INDEX_BYTES) break;
    text += entry;
  }
  return { dir, text, skipped };
}

/** Harness-authored notes (launch timings, for example) use the same file rules as the agents'. */
export async function writeMemoryNote(dir: string, slug: string, title: string, body: string): Promise<void> {
  if (!MEMORY_FILE.test(`${slug}.md`)) throw new Error(`invalid memory note name: ${slug}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${slug}.md`), `# ${title}\n${body.trim()}\n`, { mode: 0o600 });
}

const reportedSkips = new Set<string>();

/** The index for prompts; a skipped file is reported once per worker process so it is not silently ignored. */
export async function loadProjectMemory(config: Pick<WorkerConfig, "dataDir">, log: (line: string) => void = console.error): Promise<MemoryIndex> {
  const index = await projectMemoryIndex(memoryDirectory(config));
  for (const name of index.skipped) {
    if (reportedSkips.has(name)) continue;
    reportedSkips.add(name);
    log(`${new Date().toISOString()} memory note skipped (name, size or secret-looking content): ${name}`);
  }
  return index;
}
