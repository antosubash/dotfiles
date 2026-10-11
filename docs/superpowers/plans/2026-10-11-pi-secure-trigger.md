# pi issue worker: secure triggering. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only issues/PRs written, edited and labelled by users with write access (and unchanged since
labelling) start agent runs; only write-access users' commands and reviews are acted on.

**Architecture:** A `TrustService` (`src/github/trust.ts`) answers permission, label-event, edit-history
and viewer-login questions via `gh`. A trigger gate (`src/worker/trigger-gate.ts`) uses it before any
issue, plan or PR is picked up and rejects (label removed + one comment) or admits with a content hash
stored on the job. Feedback and commands get an async write-permission filter. Prompt text is
sanitised centrally in `untrustedJson`. Docker defaults off.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 24, `node:test` + `node:assert/strict`
run with `tsx --test`, `node:sqlite`, the `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-11-pi-secure-trigger-design.md`

All paths below are relative to `pi/github-issue-worker/` unless they start with `docs/` or `scripts/`.

## Global Constraints

- Every `.ts` file under `pi/` stays ≤ 300 lines (`bash scripts/tests/test-line-cap.sh` from the repo root).
- Write access means permission `admin`, `maintain` or `write` from `GET /repos/{repo}/collaborators/{login}/permission`. Never use `author_association` as the decision.
- Permission cache: in memory, keyed by lowercased login, 10 minutes.
- Freeze: any body edit or title rename strictly after the last ready-label `labeled` event rejects.
- A rejection removes the trigger label and the ready label, and posts one comment. Transient GitHub errors change nothing and are retried next poll.
- `PI_WORKER_ALLOW_DOCKER` defaults to `0`.
- Default `PI_WORKER_TRUSTED_ASSOCIATIONS` is `OWNER,COLLABORATOR`.
- No new npm dependencies. `npm run check` (build + all tests) passes after every task.
- Commit after each task, with messages `feat(pi-secure-trigger): <task>` ending with the line `Claude-Session: https://claude.ai/code/session_01NBRYERTS2VUjMFAAXqNVbZ`.

## Review Focus

1. An issue created by `/handoff` with the label applied in the same second (edit `editedAt` equals `labeledAt`) must be admitted. The comparison is strictly greater (test in Task 4).
2. An edit by a deleted account (`editor: null`) must reject, not crash (test in Task 4).
3. Login case (`Owner` vs `owner`) must hit the same cache entry and decision (test in Task 3).
4. A 5xx or network error during the gate must leave labels, comments and state untouched, so the next poll retries (test in Task 4).
5. More than 100 body edits (GraphQL page full) must fail closed with a rejection and never be treated as "no edits" (test in Task 3).

---

### Task 1: Sanitise all untrusted prompt text

**Files:**
- Modify: `src/prompts/shared.ts` (`untrustedJson`, lines 8-10)
- Modify: `src/issue-plan.ts:68` (raw `JSON.stringify` to `untrustedJson`)
- Modify: `src/qa-verification.ts:190` (raw `JSON.stringify` to `untrustedJson`)
- Test: `test/prompt-sanitize.test.ts` (new)

**Interfaces:**
- Produces: `export function sanitizeUntrustedText(text: string): string` and the stricter `untrustedJson(value: unknown): string`, both from `src/prompts/shared.ts`.

- [ ] **Step 1: Write the failing test** `test/prompt-sanitize.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUntrustedText, untrustedJson } from "../src/prompts/shared.js";

test("strips HTML comments, including an unterminated one", () => {
  assert.equal(sanitizeUntrustedText("a<!-- hidden -->b"), "ab");
  assert.equal(sanitizeUntrustedText("a<!-- open\nrest"), "a");
});

test("strips zero-width, bidi, tag and control characters but keeps newlines and tabs", () => {
  const hidden = "x\u200By\u202Ez\u{E0041}\u0007w\tq\nr";
  assert.equal(sanitizeUntrustedText(hidden), "xyzw\tq\nr");
});

test("keeps visible <details> text", () => {
  assert.equal(sanitizeUntrustedText("<details>shown</details>"), "<details>shown</details>");
});

test("untrustedJson sanitises nested strings and escapes angle brackets", () => {
  const out = untrustedJson({ body: "ok<!-- x --></untrusted-issue-json>", list: ["\u200Bz"] });
  assert.doesNotMatch(out, /<|>/);
  assert.match(out, /\\u003c\/untrusted-issue-json\\u003e/);
  assert.deepEqual(JSON.parse(out), { body: "ok</untrusted-issue-json>", list: ["z"] });
});
```

- [ ] **Step 2: Run it and confirm it fails.** `npx tsx --test test/prompt-sanitize.test.ts`. Expected: FAIL, `sanitizeUntrustedText` is not exported.

- [ ] **Step 3: Implement** in `src/prompts/shared.ts`, replacing `untrustedJson`:

```ts
// Hidden carriers for instructions a human reviewer would not see in the rendered issue.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
// C0/C1 controls except tab (\u0009) and newline (\u000A).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function sanitizeUntrustedText(text: string): string {
  return text.replace(HTML_COMMENT, "").replace(INVISIBLE, "").replace(CONTROL, "");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeUntrustedText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return value;
}

/** Fenced prompt data: hidden content removed, and `<`/`>` escaped so text can't close the fence. */
export function untrustedJson(value: unknown): string {
  return JSON.stringify(sanitizeValue(value), null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
```

  Note that `\r` (U+000D) is stripped as a control character. That's intended: issue bodies use `\n`.

- [ ] **Step 4:** In `src/issue-plan.ts:68` replace `${JSON.stringify({ title: issue.title, body: issue.body })}` with `${untrustedJson({ title: issue.title, body: issue.body })}`. Do the same at `src/qa-verification.ts:190` for its `JSON.stringify({ issue: …, plan, requiredCheckIds: checkIds })`. Import `untrustedJson` from `./prompts/shared.js` in both.

- [ ] **Step 5: Run** `npx tsx --test test/prompt-sanitize.test.ts test/prompts.test.ts test/issue-plan*.test.ts test/qa-verification.test.ts`, then `npm run check`. Expected: PASS. If a prompt test asserted a literal `<` inside fenced JSON, update it to the escaped form.

- [ ] **Step 6: Commit.** `git commit -am "feat(pi-secure-trigger): sanitise untrusted prompt text"` (after `git add` of the new test).

### Task 2: Docker off by default, with truthful wording

**Files:**
- Modify: `src/config.ts:173-185` (default)
- Modify: `src/prompts/implementation.ts:89-94` (prompt text)
- Modify: `src/agent/policy.ts:79,94` (block message)
- Modify: `src/worker/feedback-flow.ts:121` (help text)
- Modify: `README.md` (lines ~183, the section "## Automatic Docker access" around 448-460, ~504) and `.env.example:48-51`
- Test: `test/config.test.ts` (existing Docker tests around lines 30 and 114-135), `test/prompts.test.ts`

**Interfaces:** none new. `config.allowDocker` keeps its name and type.

- [ ] **Step 1: Update tests first.**
  - In `test/config.test.ts`, change the default-test assertion (line ~30) to `assert.equal(config.allowDocker, false); assert.equal(config.dockerSocket, null);`.
  - Change the socket test (~114-135) so that with a real socket and no `PI_WORKER_ALLOW_DOCKER`, `allowDocker` is `false`, and with `PI_WORKER_ALLOW_DOCKER: "1"` it is `true` and `dockerSocket` equals the socket path.
  - Keep the missing-socket test: `PI_WORKER_ALLOW_DOCKER: "1"` plus a missing socket still throws `/accessible Unix socket/`.
  - In `test/prompts.test.ts`, add: `buildFeedbackPrompt` with `dockerAccess: true` matches `/enabled for this worker by the machine owner \(PI_WORKER_ALLOW_DOCKER=1\)/` and does not match `/trusted maintainer/`.

- [ ] **Step 2: Run** `npx tsx --test test/config.test.ts test/prompts.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `src/config.ts` replace the `allowDocker` expression with `const allowDocker = booleanFlag("PI_WORKER_ALLOW_DOCKER", env.PI_WORKER_ALLOW_DOCKER ?? "0");`.
  - Delete the `automaticDocker` IIFE. Keep the later socket validation, which already runs only when `allowDocker` is true. If `statSync`, `accessSync` or `constants` become unused imports, remove them.
  - In `src/prompts/implementation.ts` replace the first sentence of the Docker block with `Docker is enabled for this worker by the machine owner (PI_WORKER_ALLOW_DOCKER=1).`. The rest of the block stays.
  - In `src/agent/policy.ts` (both places) the message becomes `"Docker is disabled for this worker (PI_WORKER_ALLOW_DOCKER=0)"`.
  - In `src/worker/feedback-flow.ts:121` the help line becomes `Docker is available only when the machine owner sets PI_WORKER_ALLOW_DOCKER=1.`
  - Docs: `.env.example` gets `# Docker is off unless set to 1. Daemon access defeats sandbox isolation; use a disposable worker host.` above `# PI_WORKER_ALLOW_DOCKER=0`. In the README, rename the section to "## Docker access (opt-in)" and rewrite its first paragraph and the bullets at ~183 and ~504 to say it is off by default and enabled per profile with `PI_WORKER_ALLOW_DOCKER=1`.
  - Run `grep -rn "explicit trusted /pi request\|automatic" src test README.md .env.example | grep -i docker` and fix any remaining claim.

- [ ] **Step 4: Run** `npm run check`. Expected: PASS. Fix any test that relied on auto-enabled Docker by setting `PI_WORKER_ALLOW_DOCKER: "1"` in its env.

- [ ] **Step 5: Commit** with `feat(pi-secure-trigger): docker off by default`.

### Task 3: TrustService

**Files:**
- Create: `src/github/trust.ts`
- Test: `test/trust.test.ts` (new)

**Interfaces:**
- Consumes: `GhRunner` and `apiPages` from `src/github/gh.ts`.
- Produces:

```ts
export interface ContentEdit { editor: string | null; editedAt: string }
export interface Approval { labeledBy: string | null; labeledAt: string | null; renames: ContentEdit[] }
export interface TrustService {
  canWrite(login: string): Promise<boolean>;
  approval(number: number, label: string): Promise<Approval>;
  bodyEdits(number: number): Promise<ContentEdit[]>;
  viewerLogin(): Promise<string | null>;
}
export class GitHubTrust implements TrustService {
  constructor(gh: GhRunner, repository: string, now?: () => number);
}
export class TooManyEditsError extends Error {}
```

- [ ] **Step 1: Write the failing tests** `test/trust.test.ts`. A fake `GhRunner` records `args` and answers by matching the joined args:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { GhRunner } from "../src/github/gh.js";
import { GitHubTrust, TooManyEditsError } from "../src/github/trust.js";

function fake(routes: Record<string, string | Error>, calls: string[] = []): GhRunner {
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    const hit = Object.entries(routes).find(([pattern]) => key.includes(pattern));
    if (!hit) throw new Error(`unexpected gh call: ${key}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
}

test("write, maintain and admin can write; triage, read and 404 cannot", async () => {
  for (const [permission, expected] of [["write", true], ["maintain", true], ["admin", true], ["triage", false], ["read", false], ["none", false]] as const) {
    const trust = new GitHubTrust(fake({ "/permission": `${permission}\n` }), "o/r");
    assert.equal(await trust.canWrite("u"), expected, permission);
  }
  const missing = new GitHubTrust(fake({ "/permission": new Error("gh api failed (1): HTTP 404: Not Found") }), "o/r");
  assert.equal(await missing.canWrite("ghost"), false);
});

test("other permission errors throw so callers retry", async () => {
  const trust = new GitHubTrust(fake({ "/permission": new Error("HTTP 502: Bad Gateway") }), "o/r");
  await assert.rejects(trust.canWrite("u"), /502/);
});

test("permission is cached per lowercased login for 10 minutes", async () => {
  let now = 0;
  const calls: string[] = [];
  const trust = new GitHubTrust(fake({ "/permission": "write" }, calls), "o/r", () => now);
  await trust.canWrite("Owner");
  await trust.canWrite("owner");
  assert.equal(calls.length, 1);
  now = 10 * 60_000 + 1;
  await trust.canWrite("owner");
  assert.equal(calls.length, 2);
});

test("approval returns the last ready-label event and all renames", async () => {
  const events = JSON.stringify([[
    { event: "labeled", label: { name: "pi-ready" }, actor: { login: "a" }, created_at: "2026-01-01T00:00:00Z" },
    { event: "renamed", actor: { login: "b" }, created_at: "2026-01-02T00:00:00Z" },
    { event: "labeled", label: { name: "PI-READY" }, actor: { login: "c" }, created_at: "2026-01-03T00:00:00Z" },
    { event: "labeled", label: { name: "pi-working" }, actor: { login: "d" }, created_at: "2026-01-04T00:00:00Z" },
  ]]);
  const trust = new GitHubTrust(fake({ "/issues/7/events": events }), "o/r");
  assert.deepEqual(await trust.approval(7, "pi-ready"), {
    labeledBy: "c",
    labeledAt: "2026-01-03T00:00:00Z",
    renames: [{ editor: "b", editedAt: "2026-01-02T00:00:00Z" }],
  });
});

test("bodyEdits maps editors and keeps deleted accounts as null", async () => {
  const page = JSON.stringify({ nodes: [{ editor: { login: "a" }, editedAt: "t1" }, { editor: null, editedAt: "t2" }], pageInfo: { hasNextPage: false } });
  const trust = new GitHubTrust(fake({ graphql: page }), "o/r");
  assert.deepEqual(await trust.bodyEdits(7), [{ editor: "a", editedAt: "t1" }, { editor: null, editedAt: "t2" }]);
});

test("more than one page of edits fails closed", async () => {
  const page = JSON.stringify({ nodes: [], pageInfo: { hasNextPage: true } });
  const trust = new GitHubTrust(fake({ graphql: page }), "o/r");
  await assert.rejects(trust.bodyEdits(7), TooManyEditsError);
});

test("viewerLogin is cached and null when gh api user fails", async () => {
  const calls: string[] = [];
  const ok = new GitHubTrust(fake({ "api user": "worker-bot\n" }, calls), "o/r");
  assert.equal(await ok.viewerLogin(), "worker-bot");
  assert.equal(await ok.viewerLogin(), "worker-bot");
  assert.equal(calls.length, 1);
  const broken = new GitHubTrust(fake({ "api user": new Error("401") }), "o/r");
  assert.equal(await broken.viewerLogin(), null);
});
```

- [ ] **Step 2: Run** `npx tsx --test test/trust.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/github/trust.ts`:

```ts
import { apiPages, type GhRunner } from "./gh.js";

export interface ContentEdit { editor: string | null; editedAt: string }
export interface Approval { labeledBy: string | null; labeledAt: string | null; renames: ContentEdit[] }
export interface TrustService {
  canWrite(login: string): Promise<boolean>;
  approval(number: number, label: string): Promise<Approval>;
  bodyEdits(number: number): Promise<ContentEdit[]>;
  viewerLogin(): Promise<string | null>;
}

/** More edits than one GraphQL page: refuse rather than verify a partial history. */
export class TooManyEditsError extends Error {}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const PERMISSION_TTL_MS = 10 * 60_000;
const EDITS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { userContentEdits(first: 100) { nodes { editor { login } editedAt } pageInfo { hasNextPage } } }
      ... on PullRequest { userContentEdits(first: 100) { nodes { editor { login } editedAt } pageInfo { hasNextPage } } }
    }
  }
}`;

interface RawEvent {
  event: string;
  created_at: string;
  actor?: { login?: string } | null;
  label?: { name?: string } | null;
}

/** Write access from the collaborator-permission API; never author_association. */
export class GitHubTrust implements TrustService {
  private readonly permissions = new Map<string, { writable: boolean; at: number }>();
  private viewer: Promise<string | null> | null = null;

  constructor(
    private readonly gh: GhRunner,
    private readonly repository: string,
    private readonly now: () => number = Date.now,
  ) {}

  async canWrite(login: string): Promise<boolean> {
    const key = login.toLowerCase();
    const cached = this.permissions.get(key);
    if (cached && this.now() - cached.at < PERMISSION_TTL_MS) return cached.writable;
    let permission = "none";
    try {
      permission = await this.gh([
        "api",
        `/repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ]);
    } catch (error) {
      if (!/\b404\b|Not Found/i.test(String(error))) throw error;
    }
    const writable = WRITE_PERMISSIONS.has(permission.trim().toLowerCase());
    this.permissions.set(key, { writable, at: this.now() });
    return writable;
  }

  async approval(number: number, label: string): Promise<Approval> {
    const events = await apiPages<RawEvent>(this.gh, `/repos/${this.repository}/issues/${number}/events?per_page=100`);
    let labeled: RawEvent | null = null;
    const renames: ContentEdit[] = [];
    for (const event of events) {
      if (event.event === "labeled" && event.label?.name?.toLowerCase() === label.toLowerCase()) labeled = event;
      if (event.event === "renamed") renames.push({ editor: event.actor?.login ?? null, editedAt: event.created_at });
    }
    return { labeledBy: labeled?.actor?.login ?? null, labeledAt: labeled?.created_at ?? null, renames };
  }

  async bodyEdits(number: number): Promise<ContentEdit[]> {
    const [owner, name] = this.repository.split("/");
    const output = await this.gh([
      "api", "graphql",
      "-f", `query=${EDITS_QUERY}`,
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-F", `number=${number}`,
      "--jq", ".data.repository.issueOrPullRequest.userContentEdits",
    ]);
    const page = JSON.parse(output) as {
      nodes: Array<{ editor: { login: string } | null; editedAt: string }>;
      pageInfo: { hasNextPage: boolean };
    };
    if (page.pageInfo.hasNextPage) throw new TooManyEditsError(`#${number} has more than 100 edits`);
    return page.nodes.map((node) => ({ editor: node.editor?.login ?? null, editedAt: node.editedAt }));
  }

  viewerLogin(): Promise<string | null> {
    this.viewer ??= this.gh(["api", "user", "--jq", ".login"]).then(
      (login) => login.trim() || null,
      () => null,
    );
    return this.viewer;
  }
}
```

  Check `apiPages`' exact signature in `src/github/gh.ts` (`apiPages<T>(gh, endpoint)` runs `api --paginate --slurp`). The events fake above returns a slurped page array (`[[...]]`).

- [ ] **Step 4: Run** `npx tsx --test test/trust.test.ts`, then `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(pi-secure-trigger): trust service`.

### Task 4: Trigger gate wired into issue, planning and PR pickup, plus the hash freeze (HARD)

**Files:**
- Create: `src/worker/trigger-gate.ts`
- Modify: `src/worker/shared.ts` (add `trust` to `WorkerContext`)
- Modify: `src/worker.ts` (construct `GitHubTrust`; require `trust` when `github` is injected; resume hash check)
- Modify: `src/worker/issue-flow.ts` (`startIssue`)
- Modify: `src/worker/planning-flow.ts`
- Modify: `src/worker/pull-request-adoption.ts` (`startPullRequest`)
- Modify: `src/github/labels.ts` and `src/github.ts` (`rejectTrigger`)
- Modify: `src/issue-plan.ts` (`issueHash` parameter type)
- Modify: `src/state/schema.ts`, `src/state/rows.ts`, `src/state/jobs.ts`, `src/state.ts`, `src/types.ts` (`trigger_hash` / `triggerHash`)
- Modify: `test/helpers/worker-fixtures.ts` (trust-all default)
- Test: `test/trigger-gate.test.ts` (new), `test/worker-trigger.test.ts` (new), `test/state.test.ts` (one case)

**Interfaces:**
- Consumes: `TrustService` and `TooManyEditsError` (Task 3).
- Produces:
  - `WorkerContext.trust: TrustService`
  - `export type TriggerResult = { ok: true; hash: string } | { ok: false; reason: string }`
  - `export async function checkTrigger(trust: TrustService, item: TriggerItem, label: string): Promise<TriggerResult>`
  - `export async function admitTrigger(ctx: WorkerContext, item: TriggerItem, label: string): Promise<string | null>`
  - `export interface TriggerItem { number: number; title: string; body: string; author?: { login: string } | null }`
  - `GitHubClient.rejectTrigger(number: number, label: string, message: string): Promise<void>`
  - `IssueJob.triggerHash: string | null`
  - `WorkerState.claim(issue, branch, worktreePath, visualRequested, triggerHash?: string | null)`
  - `export const trustingTrust: TrustService` in `test/helpers/worker-fixtures.ts`

- [ ] **Step 1: Write the failing gate tests** `test/trigger-gate.test.ts`, using an in-memory `TrustService`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { TooManyEditsError, type TrustService } from "../src/github/trust.js";
import { checkTrigger } from "../src/worker/trigger-gate.js";

const item = { number: 7, title: "T", body: "B", author: { login: "owner" } };
function trust(over: Partial<{ writers: string[]; labeledBy: string | null; labeledAt: string | null; renames: { editor: string | null; editedAt: string }[]; edits: { editor: string | null; editedAt: string }[] | Error }> = {}): TrustService {
  const writers = new Set(over.writers ?? ["owner"]);
  return {
    canWrite: async (login) => writers.has(login.toLowerCase()),
    approval: async () => ({ labeledBy: over.labeledBy === undefined ? "owner" : over.labeledBy, labeledAt: over.labeledAt === undefined ? "2026-01-02T00:00:00Z" : over.labeledAt, renames: over.renames ?? [] }),
    bodyEdits: async () => { if (over.edits instanceof Error) throw over.edits; return over.edits ?? []; },
    viewerLogin: async () => "owner",
  };
}

test("admits when author, labeller and editors can write and nothing changed after the label", async () => {
  const result = await checkTrigger(trust({ edits: [{ editor: "owner", editedAt: "2026-01-01T00:00:00Z" }] }), item, "pi-ready");
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.hash : "", /^[0-9a-f]{64}$/);
});

test("an edit in the same second as the label is admitted (strictly after rejects)", async () => {
  const same = await checkTrigger(trust({ edits: [{ editor: "owner", editedAt: "2026-01-02T00:00:00Z" }] }), item, "pi-ready");
  assert.equal(same.ok, true);
});

for (const [name, over, pattern] of [
  ["author without write", { writers: ["maint"], labeledBy: "maint" }, /author `owner` doesn't have write access/],
  ["no label event", { labeledBy: null, labeledAt: null }, /no `pi-ready` label event/],
  ["labeller without write", { labeledBy: "outsider" }, /added by `outsider`/],
  ["body edited by an outsider", { edits: [{ editor: "outsider", editedAt: "2026-01-01T00:00:00Z" }] }, /edited by `outsider`/],
  ["body edited by a deleted account", { edits: [{ editor: null, editedAt: "2026-01-01T00:00:00Z" }] }, /edited by `a deleted account`/],
  ["title renamed after the label", { renames: [{ editor: "owner", editedAt: "2026-01-03T00:00:00Z" }] }, /edited after `pi-ready` was added/],
  ["body edited after the label", { edits: [{ editor: "owner", editedAt: "2026-01-03T00:00:00Z" }] }, /edited after `pi-ready` was added/],
  ["too many edits", { edits: new TooManyEditsError("x") }, /too many edits to verify/],
] as const) {
  test(`rejects: ${name}`, async () => {
    const result = await checkTrigger(trust(over as never), item, "pi-ready");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, pattern);
  });
}

test("transient errors propagate instead of rejecting", async () => {
  await assert.rejects(checkTrigger(trust({ edits: new Error("HTTP 502") }), item, "pi-ready"), /502/);
});
```

- [ ] **Step 2: Run it** with `npx tsx --test test/trigger-gate.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement** `src/worker/trigger-gate.ts`:

```ts
import { TooManyEditsError, type TrustService } from "../github/trust.js";
import { issueHash } from "../issue-plan.js";
import { errorText, type WorkerContext } from "./shared.js";

export interface TriggerItem { number: number; title: string; body: string; author?: { login: string } | null }
export type TriggerResult = { ok: true; hash: string } | { ok: false; reason: string };

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

/**
 * Returns the content hash to pin on the job, or null when the item must not run. A rejection removes
 * the labels and comments once. A transient error changes nothing, so the next poll retries.
 */
export async function admitTrigger(ctx: WorkerContext, item: TriggerItem, label: string): Promise<string | null> {
  let result: TriggerResult;
  try {
    result = await checkTrigger(ctx.trust, item, label);
  } catch (error) {
    console.error(`${new Date().toISOString()} trigger check for #${item.number} deferred: ${errorText(error)}`);
    return null;
  }
  if (result.ok) return result.hash;
  await ctx.github.rejectTrigger(item.number, label, `⛔ Not started: ${result.reason}.`);
  return null;
}
```

  Change `issueHash`'s parameter in `src/issue-plan.ts:19` to `issue: Pick<GitHubIssue, "number" | "title" | "body">`. Its body is unchanged.

- [ ] **Step 4: Add `rejectTrigger`.** It uses REST, so it works for issues and PRs alike.

  In `src/github/labels.ts`:

```ts
export async function rejectTrigger(gh: GhRunner, config: WorkerConfig, number: number, label: string, message: string): Promise<void> {
  for (const name of new Set([label, config.readyLabel])) {
    await gh(["api", "-X", "DELETE", `/repos/${config.repository}/issues/${number}/labels/${encodeURIComponent(name)}`]).catch(() => undefined);
  }
  await gh(
    ["api", "-X", "POST", `/repos/${config.repository}/issues/${number}/comments`, "--input", "-"],
    JSON.stringify({ body: `${WORKER_MARKER}\n${message}\n` }),
  );
}
```

  `WORKER_MARKER` lives in `comments.ts`. Export it from there (`export const WORKER_MARKER`) and import it in `labels.ts`.

  In `src/github.ts` add:

```ts
  rejectTrigger(number: number, label: string, message: string): Promise<void> {
    return labels.rejectTrigger(this.gh, this.config, number, label, message);
  }
```

- [ ] **Step 5: Add the context and wiring.**
  - `src/worker/shared.ts`: `import type { TrustService } from "../github/trust.js";` and add `readonly trust: TrustService;` to `WorkerContext`.
  - `src/worker.ts`:
    - Add `trust?: TrustService` to `dependencies`.
    - Before building `this.ctx`, add:

```ts
    if (dependencies.github && !dependencies.trust) {
      throw new Error("An injected GitHub client needs an injected trust service; tests must never reach the real API");
    }
    const trust = dependencies.trust ?? new GitHubTrust(createGhRunner(), config.repository);
```

      Then add `trust` to `this.ctx`. Import `GitHubTrust` from `./github/trust.js` and `createGhRunner` from `./github/gh.js`.
  - `src/worker/issue-flow.ts` `startIssue`. Insert at the top:

```ts
  const triggerHash = await admitTrigger(ctx, issue, ctx.config.readyLabel);
  if (!triggerHash) return;
```

      Pass `triggerHash` as the new fifth argument of `ctx.state.claim(...)`.
  - `src/worker/planning-flow.ts`: inside the loop, before `try`, add

```ts
    if (!(await admitTrigger(ctx, issue, "pi-plan"))) continue;
```

      Keep `handled.add(issue.number)` before it, so a rejected planning issue isn't also picked up as ready in the same tick.
  - `src/worker/pull-request-adoption.ts` `startPullRequest`: at the top, `if (!(await admitTrigger(ctx, pullRequest, ctx.config.readyLabel))) return;`. `GitHubPullRequest extends GitHubIssue`, so `author` is present. Confirm that `listReadyPullRequests` and `getPullRequest` request `author` in their `--json` field list in `src/github/queries.ts`, and add it if missing.
  - `src/worker.ts` `resumeInterruptedIssues`, before `implementIssue(...)`:

```ts
      if (!job.triggerHash || issueHash(issue) !== job.triggerHash) {
        await handleInitialFailure(this.ctx, job.issueNumber, new Error(
          `#${job.issueNumber} changed since it was approved (or predates trigger verification). Review it and comment \`/pi retry\`.`,
        ));
        continue;
      }
```

      Import `issueHash` from `./issue-plan.js`.

- [ ] **Step 6: Add the state column.**
  - `src/state/schema.ts`: after the `ci_head_sha` migration add `if (!jobColumns.has("trigger_hash")) database.exec("ALTER TABLE issue_jobs ADD COLUMN trigger_hash TEXT");`.
  - `src/state/rows.ts`: add `trigger_hash: string | null;` to `JobRow`, and `triggerHash: row.trigger_hash ?? null,` in `mapJob`.
  - `src/types.ts`: add `triggerHash: string | null;` to `IssueJob`.
  - `src/state/jobs.ts` `claim`:
    - Add the parameter `triggerHash: string | null = null`.
    - Add `trigger_hash` to the INSERT column list with a matching `?`.
    - Add `trigger_hash = excluded.trigger_hash,` to the `ON CONFLICT` update, and pass `triggerHash` in `.run(...)`.
  - `src/state.ts`: forward the new optional argument.
  - `test/state.test.ts`: add a case where `claim(issue, "b", "/w", false, "abc")` gives `getJob(42)?.triggerHash === "abc"`, and claiming again without a hash sets it to `null`.

- [ ] **Step 7: Add the test fixture.** In `test/helpers/worker-fixtures.ts`:

```ts
import type { TrustService } from "../../src/github/trust.js";

/** Controller-flow tests assume a fully trusted maintainer; trigger rules are covered in trigger tests. */
export const trustingTrust: TrustService = {
  canWrite: async () => true,
  approval: async () => ({ labeledBy: "maintainer", labeledAt: "9999-01-01T00:00:00Z", renames: [] }),
  bodyEdits: async () => [],
  viewerLogin: async () => "pi-worker",
};
```

  Add `trust: trustingTrust,` to `TestIssueWorker`'s defaults, before `...args[2]`.

  The one test that imports the real `IssueWorker` from `../src/worker.js` (`grep -ln "IssueWorker } from \"../src/worker.js\"" test/`) must pass `trust: trustingTrust` itself. The constructor guard will say which.

  Fakes passed as `github` need `rejectTrigger` only in tests where a rejection happens.

  Resume tests: any test that resumes a `claimed` or `implementing` job claims it first. Make those claims pass the hash, so the existing flow keeps working: `issueHash(issue)` from `../src/issue-plan.js`. Find them with `grep -ln "claim(" test/worker-*.test.ts` and run the suite.

- [ ] **Step 8: Write the worker-level tests** `test/worker-trigger.test.ts`, following `test/worker-issue.test.ts`. Use a temp `WorkerState`, `config(root)`, and `TestIssueWorker` with explicit `trust` and a `github` fake that records calls.
  1. **Untrusted author.** `trust.canWrite` returns false for `issue.author.login`. After `worker.tick()` with `listReadyIssues` returning `[issue]`:
     - `rejectTrigger` was called once with `(42, "pi-ready", /author `maintainer`/)`;
     - `claimIssue` was not called;
     - `state.getJob(42)` is `undefined`/`null`.
  2. **Transient error.** `trust.approval` throws `new Error("HTTP 502")`. Neither `rejectTrigger` nor `claimIssue` is called, and there is no job.
  3. **Resume after an edit.** A job claimed with `triggerHash: "stale"` and status `implementing`, with `getIssue` returning `issue`. After `tick()` the job is `blocked`, `lastError` matches `/changed since it was approved/`, and the agent was never run.
  4. **Planning.** `listPlanningIssues` returns an issue whose labeller lacks write access. `rejectTrigger` is called with label `"pi-plan"`, and `plans.create` is not called.

- [ ] **Step 9: Run** `npx tsx --test test/trigger-gate.test.ts test/worker-trigger.test.ts test/state.test.ts`, then `npm run check` and `bash ../../scripts/tests/test-line-cap.sh`. Expected: PASS. If `issue-flow.ts` or `worker.ts` would pass 300 lines, move the resume check into `trigger-gate.ts` as `export function triggerChanged(job: IssueJob, issue: GitHubIssue): boolean`.

- [ ] **Step 10: Commit** with `feat(pi-secure-trigger): verified trigger gate and content freeze`.

### Task 5: Commands and review feedback only from write-access users

**Files:**
- Create: `src/worker/feedback-trust.ts`
- Modify: `src/worker/feedback-flow.ts:40-47`, `src/worker.ts` (`processBlockedIssueCommands`)
- Modify: `src/config.ts:115` (default associations), `.env.example`, `docs/installation.md` (~151), `docs/troubleshooting.md` (~551)
- Test: `test/feedback-trust.test.ts` (new), `test/config.test.ts`

**Interfaces:**
- Consumes: `WorkerContext.trust` (Task 4).
- Produces: `export async function writableFeedback(trust: TrustService, items: readonly PullRequestFeedback[]): Promise<PullRequestFeedback[]>`

- [ ] **Step 1: Write the failing tests.**
  - `test/feedback-trust.test.ts`:
    - With a trust stub that allows only `"owner"`, `writableFeedback` keeps the owner's items and drops `"triager"`'s, in order.
    - A trust stub whose `canWrite` throws makes `writableFeedback` reject, so callers leave events unprocessed.
  - In `test/config.test.ts`, assert that the default `trustedAssociations` is `["OWNER","COLLABORATOR"]`.
  - In `test/worker-feedback.test.ts`, add a case: a `/pi fix x` comment from a `"MEMBER"`-association user whom `trust.canWrite` rejects is not acted on (the agent isn't run and the event isn't marked processed). Override `trust` in that test only.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
// src/worker/feedback-trust.ts
import type { TrustService } from "../github/trust.js";
import type { PullRequestFeedback } from "../types.js";

/** author_association is only a prefilter; act on feedback only from users with write access. */
export async function writableFeedback(trust: TrustService, items: readonly PullRequestFeedback[]): Promise<PullRequestFeedback[]> {
  const kept: PullRequestFeedback[] = [];
  for (const item of items) if (await trust.canWrite(item.author)) kept.push(item);
  return kept;
}
```

  - In `feedback-flow.ts`, after the existing synchronous filter and before `.slice(0, 20)`, use `const pending = (await writableFeedback(ctx.trust, prefiltered)).slice(0, 20);`.
  - In `worker.ts` `processBlockedIssueCommands`, compute the synchronously filtered list, then `await writableFeedback(this.ctx.trust, candidates)`, then `.filter(parse === "retry").at(-1)`.
  - In `config.ts:115`, change the default string to `"OWNER,COLLABORATOR"`.
  - Update `.env.example` and both docs to say: "Prefilter only; the worker also checks write permission through the GitHub API. Add MEMBER if org teams grant write access."

- [ ] **Step 4: Run** `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(pi-secure-trigger): act only on write-access feedback`.

### Task 6: Evidence markers count only in the worker's own comments

**Files:**
- Modify: `src/github/comments.ts` (`hasPullRequestCommentMarker`), `src/github.ts:107`, `src/worker/evidence-recovery.ts:24-31`
- Test: `test/github-client.test.ts` (gh-level), `test/worker-adoption.test.ts` (~154, existing recovery test)

**Interfaces:**
- Consumes: `ctx.trust.viewerLogin()` (Task 3/4).
- Produces: `hasPullRequestCommentMarker(prNumber: number, marker: string, author: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test** in `test/github-client.test.ts`. A fake `gh` returns slurped pages `[[{ user: { login: "stranger" }, body: "<!-- m -->" }, { user: { login: "pi-worker" }, body: "other" }]]`.
  - `client.hasPullRequestCommentMarker(5, "<!-- m -->", "pi-worker")` is `false`.
  - With the marker in the `pi-worker` comment, it is `true`.
  - Assert the gh args start with `["api","--paginate","--slurp"]`.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.** In `comments.ts`:

```ts
export async function hasPullRequestCommentMarker(gh: GhRunner, config: WorkerConfig, prNumber: number, marker: string, author: string): Promise<boolean> {
  const items = await apiPages<RawFeedback>(gh, `/repos/${config.repository}/issues/${prNumber}/comments?per_page=100`);
  return items.some((item) => item.user?.login?.toLowerCase() === author.toLowerCase() && (item.body ?? "").includes(marker));
}
```

  - Thread `author` through `GitHubClient`.
  - In `evidence-recovery.ts`, get `const viewer = await ctx.trust.viewerLogin();` once, and only call the marker check when `viewer` is non-null. A null viewer means "marker absent", so the recovery comment is posted.
  - Update the fake in `worker-adoption.test.ts` to accept the third argument. The fixture's `trustingTrust.viewerLogin` returns `"pi-worker"`.

- [ ] **Step 4: Run** `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(pi-secure-trigger): evidence markers only from the worker`.

### Task 7: Token hygiene and docs

**Files:**
- Modify: `src/pi-agent.ts:37` (`SECRET_ENV`)
- Modify: `src/exposure.ts` (add `keyringWarning`), `src/index.ts`
- Modify: `docs/installation.md` ("GitHub credentials", ~168-176), `README.md` (worker README: trigger rules section), `.env.example:61-63`, repo-root `pi/README.md` (the paragraph added by PR #41)
- Test: `test/exposure.test.ts`

**Interfaces:**
- Produces: `export async function keyringWarning(gh: GhRunner, repository: string, env: NodeJS.ProcessEnv): Promise<string | null>`

- [ ] **Step 1: Write the failing tests** in `test/exposure.test.ts`:
  - `keyringWarning` returns `null` without calling `gh` when `GH_TOKEN` or `GITHUB_TOKEN` is set.
  - It returns a string matching `/keyring login/` for a `PUBLIC` repo with no token.
  - It returns `null` for `PRIVATE`.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
/** A public repository should use a fine-grained single-repo token, never the owner's keyring login. */
export async function keyringWarning(gh: GhRunner, repository: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return null;
  const visibility = await gh(["repo", "view", repository, "--json", "visibility", "-q", ".visibility"]);
  if (visibility.trim().toUpperCase() !== "PUBLIC") return null;
  return `${repository} is public and no GH_TOKEN is set, so the worker uses the gh keyring login. Use a fine-grained token for this repository only (see docs/installation.md).`;
}
```

  - In `index.ts`, after the refusal check, add `const warning = await keyringWarning(createGhRunner(), config.repository, process.env).catch(() => null); if (warning) console.error(`${new Date().toISOString()} warning: ${warning}`);`
  - Add `"GITHUB_ENTERPRISE_TOKEN"` to `SECRET_ENV` in `pi-agent.ts`.

- [ ] **Step 4: Docs.**
  - `docs/installation.md` "GitHub credentials": add a fine-grained token recipe. It is scoped to the single repository and needs:
    - Contents: read and write
    - Issues: read and write
    - Pull requests: read and write
    - Actions: read and write (for CI logs and reruns)
    - Metadata: read

    Put it in the profile as `GH_TOKEN=…` (mode 0600). Never use the personal keyring login for public repositories.
  - Worker `README.md`: add a "## What can start a run" section. It covers the four gate rules, re-labelling after edits, re-filing outsider issues with `/handoff`, write-permission-only commands and reviews, and the 10-minute permission cache.
  - `.env.example`: make the token comment match.
  - `pi/README.md`: one sentence pointing to the new section.

- [ ] **Step 5: Run** `npm run check` and `bash ../../scripts/tests/test-line-cap.sh`. Expected: PASS.

- [ ] **Step 6: Commit** with `feat(pi-secure-trigger): token guidance and keyring warning`.

---

## Task dependencies

- Tasks 1, 2 and 3 touch disjoint files and are independent (parallelizable).
- Task 4 depends on Task 3. It is hard: cross-cutting wiring, state migration and test fixtures.
- Task 5 depends on Task 4 (context `trust`) and Task 2 (`config.ts`, `feedback-flow.ts`, `.env.example`). Run it after both.
- Task 6 depends on Task 4.
- Task 7 depends on Task 2 (README, `.env.example`). It touches `exposure.ts`/`index.ts`, which no other task touches.
- Order if sequential: 1, 2, 3, 4, 5, 6, 7.
