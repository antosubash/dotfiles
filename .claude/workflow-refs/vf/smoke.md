# /vf — Stage 2a: Smoke check via `@playwright/cli`

Read by /vf only when Stage 2a runs (not with `--qa-passed`, `--no-smoke`, or `--skip-browser`).

Fast exploratory pass with `playwright-cli` (https://github.com/microsoft/playwright-cli). Goal: prove the app serves the feature route, the UI renders, the console is clean. Don't formalize assertions — this is reconnaissance for the 2b spec.

The CLI is **stateful**: `open` starts a session, later commands act on it. Always use the named session `-s=vf` so parallel sessions don't collide. Each command gets `timeout: 30000`.

```bash
SESSION=vf
playwright-cli -s=$SESSION open "http://localhost:<port><route>"
playwright-cli -s=$SESSION snapshot > "$VF_DIR/snapshot.txt"      # element refs for later commands

# Drive the feature (adapt to the description), snapshot between actions to confirm state changed:
#   playwright-cli -s=$SESSION click "getByRole('button', { name: 'Save' })"
#   playwright-cli -s=$SESSION fill  "getByLabel('Email')" "test@example.com"
#   playwright-cli -s=$SESSION press Enter

playwright-cli -s=$SESSION screenshot --filename="$VF_DIR/smoke.png"
playwright-cli -s=$SESSION requests > "$VF_DIR/requests.txt"     # network log
playwright-cli -s=$SESSION eval "() => ({title: document.title, url: location.href})"
playwright-cli -s=$SESSION close
```

**`--use-mcp`:** the Playwright MCP tools (`mcp__plugin_playwright_playwright__*`: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_take_screenshot`) may drive the same actions instead. Save the screenshot to `$VF_DIR/smoke.png`. Never use MCP or `playwright-cli` for 2b — durable specs always go through `@playwright/test`.

**Passes if all hold:**
- First response status < 400 (from `requests`, or no error page in the snapshot).
- Page title non-empty.
- Feature-specific elements named in the description appear in the snapshot.
- No JavaScript errors during navigation/interaction.

If smoke fails, STOP before writing a spec — fix the app first. Leave the dev server running so the user can inspect.
