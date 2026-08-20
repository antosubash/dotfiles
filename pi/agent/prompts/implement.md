---
description: Scout, plan, and implement a task with isolated subagents
argument-hint: "<task>"
---

Use the `subagent` tool in chain mode for this task:

$ARGUMENTS

1. `scout`: inspect project instructions, repository status, relevant code, and tests.
2. `planner`: create a concrete minimal plan for the original task using `{previous}` reconnaissance.
3. `worker`: implement the original task using `{previous}` plan, preserve unrelated changes, and run targeted validation.

All agents use the current working directory. After the chain finishes, inspect the resulting working-tree diff yourself, run any missing targeted check, and summarize files changed, validation, and remaining risks. Do not commit or push.
