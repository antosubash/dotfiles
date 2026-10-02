# Working with me

I start work and then leave it alone. Every time you stop to ask something you could have decided, or offer to do something instead of doing it, I lose a round trip. Default to finishing.

## Autonomy

- **Do in-scope follow-ups. Don't offer them.** If you find a bug, a missing step, or an obvious next action that belongs to the current task, do it and mention it in the summary. Don't end with "I can do X if you want" or "want me to…?" for work that's clearly part of the job.
- **Run things yourself.** Start servers, run migrations, run tests, open the browser, read the logs. Only hand me a step that truly needs a human: `sudo`, an interactive login, entering a secret, or a physical action. When you do, give the exact command (prefixed with `!` so it runs in this session) and continue as soon as it's done, without waiting for me to say "go".
- **Wait for background work yourself.** After starting a server, build, deploy or job, watch it (Monitor, or a polling loop with a timeout) until it's ready or has failed, then carry on or report. Never end a turn with "it's starting, let me know when it's up".
- **End a turn only when:** the task is done and verified, or you're blocked on something only I can provide. "Making progress" and "here's a checkpoint" aren't reasons to stop.
- **Ask in one batch.** If you need decisions from me, collect every open question and ask them all at once, each with a recommended default. Don't ask one question per turn.
- **Pick sensible defaults.** For choices with a conventional answer (naming, file layout, library already used in the repo, test framework), decide and note it. Ask only about decisions that change what gets built.

## Design approval

- Show a design **in one piece**: every section, every decision, and the trade-offs you picked. Ask for **one** approval of the whole thing. Don't present it section by section and stop after each one. This overrides the section-by-section step in the superpowers brainstorming skill.
- My approval of the design also approves writing the spec and plan and starting implementation. Only stop again if the implementation has to depart from the approved design in a way that matters.

## Ground rules that still apply

- Never push to `main`/`master`, force-push, or merge PRs unless I ask. Work on a branch or worktree and open a PR.
- Never commit secrets (`.env*`, `*.pem`, `credentials*`).
- Destructive or outward-facing actions (deleting data, dropping databases, posting to external services, anything touching `prod`) still need my confirmation.
- Report results honestly: if a test fails or a step was skipped, say so.

## Repo conventions

- If a repo has a `running-the-stack` skill (or a launch section in its CLAUDE.md), use it to start the app. If it doesn't and you've just worked out how to run the app, run `/runbook` so the next session doesn't have to work it out again.
- For a new feature from idea to PR, `/feature` is the end-to-end path. To finish a branch, use `/ship`.
- Well-defined work (clear bug, scoped change, approved design) can go to the background pi issue worker with `/handoff` (or `/feature --pi`); it comes back as a draft PR. Don't hand off open-ended or design work.
