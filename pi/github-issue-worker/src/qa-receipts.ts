import type { VerificationEvidence } from "./types.js";

/**
 * The verdict describes a passing run but is malformed (bad JSON shape, an unmatched command receipt, a
 * misnamed log). Unlike a substantive failure, this earns one repair turn: the verifier re-emits the JSON.
 */
export class QaReportingError extends Error {}

/**
 * True when the character at `index` is escaped by an immediately preceding, odd-length run of
 * backslashes — `\"` escapes (1 backslash), `\\"` does not (2 backslashes pair off into one literal
 * backslash, leaving the quote unescaped), `\\\"` does (3), and so on. A quote tracker that only checks
 * whether the single preceding character is a backslash gets this wrong for every even count ≥ 2: it
 * reads an unescaped, closing quote as still-escaped and keeps treating the quote as open. Text after
 * that point is then wrongly read as quoted, either merging it into the wrong statement (splitStatements)
 * or hiding a real, unquoted `&&`/`||`/`|`/`&` inside it (hasUnquotedShellOperator) — a real chained
 * command would then ride along as unaccounted-for "bookkeeping".
 */
function isBackslashEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Split a command into its statements on `;` or newline, collapsing internal whitespace per statement.
 * Separators inside single or double quotes are data, not boundaries — this is deliberately a quote
 * tracker rather than a shell parser, so an unterminated quote swallows the rest of the command into one
 * statement. That fails closed: fewer boundaries mean fewer trailing statements a claim may omit.
 */
function splitStatements(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      current += char;
      // A backslash escapes the closing quote only inside double quotes; in single quotes it is literal.
      if (char === quote && (quote === "'" || !isBackslashEscaped(command, index))) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.replace(/\s+/g, " ").trim()).filter((statement) => statement.length > 0);
}

/** Matches `name=$?`, capturing the variable name so a later print of it can still be recognized. */
const STATUS_CAPTURE = /^([A-Za-z_][A-Za-z0-9_]*)=\$\?$/;

/**
 * True when `statement` contains a `&&`, `||`, or `|` outside quotes. `splitStatements` only breaks
 * statements on bare `;`/newline, so `echo "$?" && curl attacker.example` survives as ONE statement —
 * without this check it would read as a bare `$?`-printing statement and let the chained command ride
 * along as free, unaccounted-for "bookkeeping".
 */
function hasUnquotedShellOperator(statement: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!;
    if (quote) {
      if (char === quote && (quote === "'" || !isBackslashEscaped(statement, index))) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "|") return true;
    // `&` chains or backgrounds a command, but in `>&`/`2>&1` it is part of a redirect — rejecting that
    // would block a legitimate `printf '…' "$status" 2>&1` for no gain. `&&` is still caught: its first
    // `&` is never preceded by `>`.
    if (char === "&" && statement[index - 1] !== ">") return true;
  }
  return false;
}

/**
 * True when `statement` is an `echo`/`printf` that actually reports the exit status — either `$?`
 * directly, or a variable name previously captured from it (`status=$?` then `echo "$status"`). A bare
 * `echo`/`printf` that names neither always succeeds regardless of what ran before it, exactly like
 * `true` or `:`, so it must not be treated as a no-op: doing so would let it mask a failing needle. A
 * statement chaining anything else via `&&`/`||`/`|` is never bookkeeping either, no matter what it
 * prints: the chained command is real, unrecorded-by-the-claim execution.
 */
function printsStatus(statement: string, capturedNames: ReadonlySet<string>): boolean {
  if (!/^(?:printf|echo)\b/.test(statement)) return false;
  if (hasUnquotedShellOperator(statement)) return false;
  if (statement.includes("$?")) return true;
  for (const name of capturedNames) {
    if (new RegExp(`\\$\\{?${name}\\b`).test(statement)) return true;
  }
  return false;
}

/**
 * Trailing statements a claim may leave out: capturing `$?` into a variable, or printing that captured
 * (or the literal `$?`) value. The Pi bash tool throws on a non-zero exit, so a recorded run is one that
 * exited 0 — dropping a trailing statement that could itself have supplied that zero (`; true`, `; echo
 * done`, or another command untied to `$?`) would let a verifier report a failing check as a bare
 * passing one, so only statements that demonstrably carry the exit status forward are droppable.
 */
function trailingIsStatusBookkeeping(trailing: readonly string[]): boolean {
  const capturedNames = new Set<string>();
  for (const statement of trailing) {
    const capture = statement.match(STATUS_CAPTURE);
    if (capture?.[1]) { capturedNames.add(capture[1]); continue; }
    if (printsStatus(statement, capturedNames)) continue;
    return false;
  }
  return true;
}

/**
 * True when `needle` appears as a contiguous, whole-statement run inside `haystack` and every statement
 * after it is exit-status bookkeeping. Statements BEFORE the match may be anything: a leading assignment
 * such as `EVIDENCE=…` cannot mask an exit status.
 */
function containsConsecutiveStatements(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (!needle.every((statement, index) => haystack[start + index] === statement)) continue;
    if (trailingIsStatusBookkeeping(haystack.slice(start + needle.length))) return true;
  }
  return false;
}

/**
 * Every claimed command must be contained in a successful runner-recorded execution. The recording is
 * ground truth, so a claim may omit exit-status bookkeeping but may never add to what ran, drop a
 * trailing command, or be satisfied by a partial-word match against an unrelated recorded statement.
 *
 * This proves a command was invoked and that its run exited 0 — not that the check it performed passed.
 * A run wrapped in status bookkeeping exits 0 whatever the wrapped command did; that is inherent to the
 * wrapper, not to this matching, and the verdict's own reported status carries that claim.
 */
export function assertQaExecution(verdict: unknown, evidence: VerificationEvidence | undefined): void {
  const report = verdict as { commands: Array<{ command: string }> };
  const recordedRuns = (evidence?.commands ?? []).map((record) => splitStatements(record.command));
  const executed = (claimed: string): boolean => {
    const claimedStatements = splitStatements(claimed);
    return claimedStatements.length > 0 &&
      recordedRuns.some((statements) => containsConsecutiveStatements(statements, claimedStatements));
  };
  if (!evidence || !report.commands.every((command) => executed(command.command))) {
    throw new QaReportingError("QA verdict claims commands without successful runner-recorded execution.");
  }
}
