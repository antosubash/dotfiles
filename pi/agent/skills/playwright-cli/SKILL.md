---
name: playwright-cli
description: Drives browser testing with the stateful Playwright CLI. Use for browser reconnaissance, UI interaction, screenshots, console/network inspection, accessibility snapshots, responsive checks, and QA evidence.
compatibility: Requires Node.js 18+ and the playwright-cli binary from @playwright/cli.
---

# Playwright CLI

Use `playwright-cli --help [command]` as the authoritative command reference.

## Session discipline

Always use a unique named session so concurrent agents do not collide:

```bash
SESSION="pi-<purpose>-<unique-id>"
playwright-cli -s="$SESSION" open "http://localhost:3000/path"
playwright-cli -s="$SESSION" snapshot --filename=/tmp/snapshot.txt
# Interact using refs such as e12 returned by snapshot.
playwright-cli -s="$SESSION" click e12
playwright-cli -s="$SESSION" fill e18 "value"
playwright-cli -s="$SESSION" screenshot --filename=/tmp/evidence.png
playwright-cli -s="$SESSION" console error
playwright-cli -s="$SESSION" requests
playwright-cli -s="$SESSION" close
```

Use a shell trap or explicit cleanup so the session closes on failure. Never use another agent's session.

## Workflow

1. Open the exact target URL.
2. Snapshot before interacting; never guess refs.
3. Perform one scenario at a time and snapshot after state-changing actions.
4. Save screenshots to the run directory supplied by the caller.
5. Inspect console errors and failed HTTP requests.
6. Record steps, expected result, actual result, severity, and evidence path.
7. Close the session.

Useful commands include `goto`, `click`, `fill`, `type`, `press`, `select`, `check`, `hover`, `resize`, `eval`, `run-code`, `tab-*`, `console`, `requests`, `request`, `screenshot`, and `state-save/state-load`.

For parallel QA, give every agent a different session name and evidence filename prefix. Use `playwright-cli close-all` only during final cleanup when no other browser work should remain.
