---
description: Delegate a read-only code review to the reviewer subagent
argument-hint: "[target or scope]"
---

Use the `reviewer` subagent to review ${ARGUMENTS:-the complete current branch diff and uncommitted changes}. Tell it to read the applicable project instructions, inspect surrounding code and tests, and return findings ordered by severity with exact file:line references and a final `VERDICT` line.

Present findings first. Do not modify files.
