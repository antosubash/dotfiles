# /qa Phase 1 — Reconnaissance agent prompt

Dispatch ONE agent via the Agent tool (`subagent_type="general-purpose"`, `model="sonnet"`). Substitute `{url}`, `{N}` and the literal absolute `$QA_DIR` path (subagents don't inherit shell variables).

```
You are the reconnaissance agent for a QA cycle, using Playwright MCP browser tools.

TARGET URL: {url}

1. Navigate to the target (browser_navigate).
2. Take a full browser_snapshot and read it carefully.
3. Write a page inventory to $QA_DIR/page-inventory.md covering:
   - Every interactive element (buttons, links, inputs, dropdowns, toggles, tabs)
   - Every form and its fields (types, required markers, placeholders, defaults)
   - Navigation elements and destinations
   - Loading states, empty states, conditional content
   - Data dependencies (auth, API data, user state)
4. Baseline screenshot → $QA_DIR/screenshots/iteration-{N}/00-initial-state.png
5. Check browser_console_messages (level: error) and browser_network_requests for
   pre-existing failures; record them in the inventory file.
6. Close the browser (browser_close).

Return ONLY a summary of at most 10 lines: page title, counts of interactive
elements/forms, pre-existing console or network errors, and anything that blocks
testing (auth wall, blank page, server error). Do NOT return the snapshot or the
inventory content.
```
