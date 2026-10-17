import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "@earendil-works/pi-ai";

const MAX_BYTES = 50 * 1024;
const MAX_LINE_CHARS = 500;
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const GREP_LIMIT = 100;
const FIND_LIMIT = 1000;
const LS_LIMIT = 500;

/**
 * Files the tool policy refuses to `read` (`toolBlockReason`), kept out of every `grep` walk as well. A path-only policy
 * cannot see inside a directory search, and a `glob` argument whitelists files `.gitignore` would otherwise hide (an
 * ignored `.env` in the worktree), so these exclusions come last: in ripgrep the last matching glob wins.
 */
const SECRET_FILE_GLOBS = ["!.env", "!.env.*", "!appsettings.secrets.json"];

type Output = { output: { type: "text"; text: string }[] };

function requireEnv(api: ToolExecutionApi): ExecutionEnv {
  if (api.env === undefined) throw new Error("No execution environment");
  return api.env;
}

function text(value: string): Output {
  return { output: [{ type: "text", text: value }] };
}

function formatSize(bytes: number): string {
  return `${bytes / 1024}KB`;
}

/** Keep whole leading lines up to MAX_BYTES; `truncated` says whether anything was dropped. */
function truncateHead(content: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content) <= MAX_BYTES) return { content, truncated: false };
  const kept: string[] = [];
  let bytes = 0;
  for (const line of content.split("\n")) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (bytes + lineBytes > MAX_BYTES) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return { content: kept.join("\n"), truncated: true };
}

function withNotices(body: string, notices: string[]): string {
  const bounded = truncateHead(body);
  if (bounded.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
  return notices.length > 0 ? `${bounded.content}\n\n[${notices.join(". ")}]` : bounded.content;
}

type Captured = { exitCode: number; stdout: string; stderr: string; missing: boolean };

/** Run `argv` directly (no shell) and collect its output; spawn failures and shell "not found" (127) set `missing`. */
async function capture(env: ExecutionEnv, argv: readonly string[], cwd: string, context: Context): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(
    argv,
    {
      cwd,
      onOutput: (chunk, _context, info) => {
        if (info.stream === "stderr") stderr += chunk;
        else if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk;
      },
    },
    context,
  );
  if (!result.ok) {
    if (result.error.code === "spawn_error") return { exitCode: 127, stdout, stderr: result.error.message, missing: true };
    throw result.error;
  }
  const { exitCode } = result.value;
  return { exitCode, stdout, stderr, missing: exitCode === 127 };
}

/** The directory to search from and, for a file target, its name. */
async function resolveTarget(env: ExecutionEnv, path: string | undefined, context: Context) {
  const absolute = getOrThrow(await env.absolutePath(path || ".", context));
  const info = await env.fileInfo(absolute, context);
  if (!info.ok) throw new Error(`Path not found: ${absolute}`);
  if (info.value.kind === "directory") return { dir: absolute };
  const slash = absolute.lastIndexOf("/");
  return { dir: slash <= 0 ? "/" : absolute.slice(0, slash), file: absolute.slice(slash + 1) };
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

function truncateLine(line: string): { text: string; truncated: boolean } {
  if (line.length <= MAX_LINE_CHARS) return { text: line, truncated: false };
  return { text: `${line.slice(0, MAX_LINE_CHARS)}... [truncated]`, truncated: true };
}

/** `rg --null` lines are `path\0<line>:<text>` for matches and `path\0<line>-<text>` for context. */
const RG_LINE = /^([^\0]*)\0(\d+)([:-])(.*)$/;

function formatGrep(stdout: string, limit: number) {
  const out: string[] = [];
  let matches = 0;
  let limitReached = false;
  let linesTruncated = false;
  for (const raw of stdout.split("\n")) {
    const found = RG_LINE.exec(raw.replace(/\r$/, ""));
    if (found === null) {
      if (raw === "--" && !limitReached) out.push("--");
      else if (raw === "--") break;
      continue;
    }
    const [, rawFile, lineNumber, kind, body] = found as unknown as [string, string, string, ":" | "-", string];
    const file = rawFile.replace(/^\.\//, "");
    if (kind === ":") {
      if (matches >= limit) {
        limitReached = true;
        break;
      }
      matches++;
    }
    const line = truncateLine(body);
    linesTruncated ||= line.truncated;
    out.push(kind === ":" ? `${file}:${lineNumber}: ${line.text}` : `${file}-${lineNumber}- ${line.text}`);
  }
  while (out.at(-1) === "--") out.pop();
  return { lines: out, matches, limitReached, linesTruncated };
}

const grep = defineTool({
  name: "grep",
  description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${GREP_LIMIT} matches or ${formatSize(MAX_BYTES)} (whichever is hit first). Long lines are truncated to ${MAX_LINE_CHARS} chars.`,
  parameters: grepSchema,
  replay: "safe",
  async execute(args, api, context) {
    const env = requireEnv(api);
    const target = await resolveTarget(env, args.path, context);
    const limit = Math.max(1, args.limit ?? GREP_LIMIT);
    const contextLines = args.context !== undefined && args.context > 0 ? Math.floor(args.context) : 0;
    const argv = ["rg", "--line-number", "--with-filename", "--null", "--color=never", "--hidden", "--glob", "!.git/"];
    if (args.ignoreCase) argv.push("--ignore-case");
    if (args.literal) argv.push("--fixed-strings");
    if (contextLines > 0) argv.push("--context", String(contextLines));
    if (args.glob) argv.push("--glob", args.glob);
    for (const secret of SECRET_FILE_GLOBS) argv.push("--iglob", secret);
    argv.push("--", args.pattern, target.file ?? ".");
    const run = await capture(env, argv, target.dir, context);
    if (run.missing) throw new Error("ripgrep (rg) is not available");
    const result = formatGrep(run.stdout, limit);
    if (run.exitCode > 1 && result.matches === 0) {
      const message = (run.stderr.trim() || run.stdout.replaceAll("\0", ":").trim());
      throw new Error(message || `ripgrep exited with code ${run.exitCode}`);
    }
    if (result.matches === 0) return text("No matches found");
    const notices: string[] = [];
    if (result.limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    const body = withNotices(result.lines.join("\n"), notices);
    if (!result.linesTruncated) return text(body);
    return text(`${body}\n[Some lines truncated to ${MAX_LINE_CHARS} chars. Use read tool to see full lines]`);
  },
});

const findSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

async function insideGitRepo(env: ExecutionEnv, dir: string, context: Context): Promise<boolean> {
  for (let current = dir; ; ) {
    const marker = getOrThrow(await env.joinPath([current, ".git"], context));
    const exists = await env.exists(marker, context);
    if (exists.ok && exists.value) return true;
    const parent = getOrThrow(await env.absolutePath(getOrThrow(await env.joinPath([current, ".."], context)), context));
    if (parent === current) return false;
    current = parent;
  }
}

const find = defineTool({
  name: "find",
  description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${FIND_LIMIT} results or ${formatSize(MAX_BYTES)} (whichever is hit first).`,
  parameters: findSchema,
  replay: "safe",
  async execute(args, api, context) {
    const env = requireEnv(api);
    const target = await resolveTarget(env, args.path, context);
    if (target.file !== undefined) throw new Error(`Not a directory: ${target.dir}/${target.file}`);
    const limit = args.limit ?? FIND_LIMIT;
    const flags = ["--glob", "--color=never", "--hidden", "--exclude", ".git"];
    if (!(await insideGitRepo(env, target.dir, context))) flags.push("--no-require-git");
    flags.push("--max-results", String(limit));
    let pattern = args.pattern;
    if (pattern.includes("/")) {
      flags.push("--full-path");
      if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
    }
    let run = await capture(env, ["fd", ...flags, "--", pattern], target.dir, context);
    if (run.missing) run = await capture(env, ["fdfind", ...flags, "--", pattern], target.dir, context);
    if (run.missing) throw new Error("fd is not available (tried fd and fdfind)");
    const paths = run.stdout.split("\n").map((line) => line.replace(/\r$/, "").replace(/^\.\//, "")).filter(Boolean);
    if (run.exitCode !== 0 && paths.length === 0) throw new Error(run.stderr.trim() || `fd exited with code ${run.exitCode}`);
    if (paths.length === 0) return text("No files found matching pattern");
    const notices: string[] = [];
    if (paths.length >= limit) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    return text(withNotices(paths.join("\n"), notices));
  },
});

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

const ls = defineTool({
  name: "ls",
  description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_LIMIT} entries or ${formatSize(MAX_BYTES)} (whichever is hit first).`,
  parameters: lsSchema,
  replay: "safe",
  async execute(args, api, context) {
    const env = requireEnv(api);
    const dir = getOrThrow(await env.absolutePath(args.path || ".", context));
    const info = await env.fileInfo(dir, context);
    if (!info.ok) throw new Error(`Path not found: ${dir}`);
    const limit = args.limit ?? LS_LIMIT;
    const listed = await env.listDir(dir, context);
    if (!listed.ok) throw new Error(info.value.kind === "directory" ? `Cannot read directory: ${listed.error.message}` : `Not a directory: ${dir}`);
    const entries = [...listed.value].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const results: string[] = [];
    for (const entry of entries.slice(0, limit)) {
      let isDirectory = entry.kind === "directory";
      if (entry.kind === "symlink") {
        // Like stat: a link to a directory is listed as a directory; a dangling link as a plain entry.
        const followed = await env.canonicalPath(entry.path, context);
        const target = followed.ok ? await env.fileInfo(followed.value, context) : undefined;
        isDirectory = target?.ok === true && target.value.kind === "directory";
      }
      results.push(isDirectory ? `${entry.name}/` : entry.name);
    }
    if (results.length === 0) return text("(empty directory)");
    const notices: string[] = [];
    if (entries.length > limit) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
    return text(withNotices(results.join("\n"), notices));
  },
});

/** Read-only `grep`, `find` and `ls` for agents that have no `bash` tool. */
export function createSearchTools(): ToolRegistration[] {
  return [grep, find, ls] as unknown as ToolRegistration[];
}
