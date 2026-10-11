# pi issue worker: secure triggering

## Goal and scope

A stranger on a public repository must never be able to start an agent run or change what the
owner approved. Today the `pi-ready` label is the whole trigger: whoever wrote the issue, whoever
edited it after labelling, and anything hidden in HTML comments reaches the agent. Comment commands
are gated on `author_association`, which counts read-only org members.

In scope: issue, planning and pull-request pickup; `/pi` commands and review feedback; prompt
sanitising; evidence-marker spoofing; Docker default; token guidance.
Out of scope: running each profile under its own OS user, systemd hardening, CI secrets on agent
branches, project-memory replay (separate follow-ups from the same review). PR #41 (refuse
unsandboxed public repos) is independent and stays as is.

## Approach

One rule everywhere: **only text written, edited and approved by people with write access runs, and
only as it was when approved.** Permission comes from
`GET /repos/{repo}/collaborators/{login}/permission` (`admin`, `maintain` or `write`), never from
`author_association`.

Rejected alternatives:
- *Association-only trust:* `MEMBER`/`COLLABORATOR` include read-only and triage users.
- *A `/pi approve <hash>` comment as the trigger:* also secure, but adds a step to every issue,
  while the label already is the approval signal once the labeller is verified.
- *GitHub App + webhooks:* stronger identity, but new infrastructure for one user's machine.

## Design

### Trust checks: `src/github/trust.ts` (new)
`TrustChecker` wraps the `GhRunner`:
- `canWrite(login)`: permission lookup, cached in memory per login for 10 minutes. A 404 (not a
  collaborator) is `false`. Any other error throws, so callers retry next tick instead of deciding.
- `approval(number, readyLabel)`: from `GET /repos/{repo}/issues/{n}/events` (paginated), the last
  `labeled` event for the label (`actor`, `created_at`), plus every `renamed` event (title edits).
- `bodyEdits(number)`: GraphQL `userContentEdits { editor { login } editedAt }` on the issue or PR.
- `viewerLogin()`: `gh api user --jq .login`, cached.

### Trigger gate: `src/worker/trigger-gate.ts` (new)
`checkTrigger(ctx, item, kind)` returns `{ ok: true, hash }` or `{ ok: false, reason }`. It accepts
only if all of these hold:
1. The issue/PR author can write.
2. A `labeled` event for the ready label exists and its actor can write.
3. Every body editor and title renamer can write.
4. No body edit or rename happened after that `labeled` event. This is the freeze: changing an
   approved issue needs a fresh label from a maintainer.

It runs at the top of `startIssue` (covers the poll loop and `/pi retry`), at planning start in
`planning-flow.ts`, and at `startPullRequest` (PR adoption, which also checks the PR author). On
rejection the worker removes the ready label and comments the reason once (no claim, no job row):
for example "Not started: issue author `x` doesn't have write access. A maintainer can re-file it."
Transient errors leave the label and retry next poll.

`hash = issueHash(issue)` (existing, from `issue-plan.ts`) is stored in a new `issue_jobs.trigger_hash`
column at claim. `implementIssue` (including `resumeInterruptedIssues`) re-fetches the issue and
blocks the job if the hash changed.

### Commands and review feedback
`isActionableFeedback` stays the cheap synchronous prefilter (association + `/pi` prefix). A new async
`filterWritable(ctx, items)` then keeps only items whose author can write; `feedback-flow.ts` and
`processBlockedIssueCommands` call it before acting. An error leaves the event unprocessed (existing
convention). Default `PI_WORKER_TRUSTED_ASSOCIATIONS` becomes `OWNER,COLLABORATOR`. Org setups that
grant write through teams can add `MEMBER` back, safely, since permission is checked anyway.

### Prompt sanitising: `src/prompts/shared.ts`
`untrustedJson` sanitises every string it serialises: it removes HTML comments (an unterminated one to
end of text), zero-width and bidi-control characters, Unicode tag characters (U+E0000–U+E007F) and
other control characters except newline and tab. It also escapes `<` and `>` as `<` and
`>` so a body can't close the fence. `<details>` text stays, because it's visible. `issue-plan.ts:68`
and `qa-verification.ts:190` switch from raw `JSON.stringify` to `untrustedJson`.

### Evidence marker
`hasPullRequestCommentMarker` fetches `user.login` with each body and counts a marker only in comments
written by `viewerLogin()`. If the login can't be read, it treats the marker as absent. That re-posts
a recovery comment, which is harmless.

### Docker
`PI_WORKER_ALLOW_DOCKER` defaults to `0`. The socket is only validated when Docker is enabled. The
feedback prompt says "Docker is enabled for this worker by the machine owner
(PI_WORKER_ALLOW_DOCKER=1)" instead of claiming a maintainer granted it. The policy block message,
help text, README and `.env.example` change to match.

### Tokens
A profile `GH_TOKEN` already works: the supervisor passes only the profile's token to its child. Add:
- At startup, log a warning when the repo is public and no `GH_TOKEN` is set ("using the gh keyring
  login").
- `GITHUB_ENTERPRISE_TOKEN` added to `pi-agent.ts` `SECRET_ENV` (matching the supervisor).
- `docs/installation.md`: a fine-grained, single-repo token per profile with Contents, Issues, Pull
  requests (read/write), Actions (read/write, for CI logs and reruns) and Metadata (read). Never the
  personal keyring login on public repos.

## Decisions made (override any at approval)
- **Freeze rule:** any edit after the label, even by a maintainer, needs re-labelling. This is simple
  and visible, and a maintainer editing would usually relabel anyway.
- **Outside-authored issues are always rejected,** even if a maintainer labels them. The maintainer
  re-files them with `/handoff`. This removes hidden-content risk entirely.
- **Permission cache:** 10 minutes, in memory only, so a revoked collaborator can act for up to
  10 minutes.
- **`MEMBER` dropped from the default** prefilter. The permission check is the real gate either way.
- **No new `/pi docker` command.** Docker is a per-profile owner decision, off by default.

## Testing
- `trust.test.ts`: permission mapping (write/maintain/admin true; triage/read/404 false; 500 throws),
  cache hit and expiry, events parsing (last label, renames), GraphQL edit parsing, viewer login.
- `trigger-gate.test.ts`: each rejection reason, edit-after-label, all-trusted pass, transient error
  does not reject.
- Worker flow: a rejected issue loses the label, gets one comment and no job; a retry from a
  non-writer is ignored; a hash change on resume blocks.
- `prompts.test.ts`: comment, zero-width and tag stripping; `</untrusted-…>` escaped; planning and QA
  prompts fenced.
- `config.test.ts`: Docker default off, and the socket only validated when enabled.
- Evidence: a marker from another user doesn't suppress recovery.
- The existing worker-flow fakes get a shared trust-all `trust` stub from `test/helpers`, so the gate
  is required in production and never skipped silently.
- Full `npm run check`, plus the line-cap test (new logic in new modules; `feedback-flow.ts` and
  `config.ts` are near 300 lines).

## Risks
- Verified live (read-only) on 2026-10-11 against `antosubash/smpy_modules`:
  - the permission endpoint returns `admin` for the owner and `read` (not 404) for an outsider on a public repo;
  - `issues/{n}/events` returns `labeled` events with `actor` and the label name (for example `pi-ready` on #47);
  - GraphQL `userContentEdits` resolves for issues and PRs;
  - `gh api user` returns the login.

  Fine-grained tokens still need the same calls checked once a per-repo token exists. If GraphQL edits
  aren't available to such a token, the gate rejects (fail closed) and the docs list the needed
  permission.
- When the worker runs as the owner's keyring login, its own label changes show the owner as actor.
  The gate only reads the last `pi-ready` `labeled` event, which the worker never applies itself.
- Many worker tests build partial `github` fakes, so wiring the trust stub touches about 10 test files
  (mechanical).
