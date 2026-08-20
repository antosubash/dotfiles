---
description: Validate the current work with relevant project checks
argument-hint: "[additional instructions]"
---
Validate the current work. ${ARGUMENTS:-Use the repository's normal validation workflow.}

Read the applicable project instructions, inspect the changed files, and detect the affected stack and workspace. Run the narrowest relevant checks first, then broader formatter checks, lint, type-check, build, and tests where warranted. Do not rewrite unrelated files or fix failures unless explicitly requested.

Report every command run and whether it passed, failed, or could not run. Distinguish failures caused by the current changes from pre-existing or environmental failures.
