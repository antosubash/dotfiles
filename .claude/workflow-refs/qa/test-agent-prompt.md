# /qa Phase 2 — Test agent prompt template + per-agent mandates

Each test agent gets the template below with `TESTING MANDATE` replaced by its category's mandate. Substitute `{url}`, `{N}`, `{category}` and the literal absolute `$QA_DIR` path — agents don't inherit shell variables. Launch every agent in ONE message, each with `model: "sonnet"`, no worktree.

## Template

```
You are a QA test agent. Your job is to test a specific category of scenarios on a web page using Playwright MCP tools.

TARGET URL: {url}
ITERATION: {N}
SCREENSHOT DIR: $QA_DIR/screenshots/iteration-{N}/

PAGE INVENTORY:
Read $QA_DIR/page-inventory.md FIRST — it is the shared map of the page all test
agents work from. Do not skip it.

TESTING MANDATE:
{category-specific instructions — see below}

INTERACTION RULES:
- Always browser_snapshot before interacting to get element refs — never guess selectors
- Use browser_click, browser_type, browser_fill_form, browser_select_option, browser_press_key for interactions
- After every action, browser_snapshot to verify the UI updated
- After actions that trigger network requests, browser_wait_for before the next snapshot
- Take a browser_take_screenshot for every test scenario as evidence
- Check browser_console_messages (level: error) after interactions
- Name screenshots: {NN}-{category}-{description}.png
- Native dialogs: browser_handle_dialog. UI-framework modals: normal snapshot → click.
- File uploads: browser_file_upload with a small test file.
- Auth-gated: if redirected to login, document it, attempt test credentials, report what's blocked if you can't get in.
- Be adversarial: think like a confused, impatient, malicious, mobile, or keyboard-only user;
  try sequences (do A, then B, then undo A) and state changes (refresh, navigate away, return).
- Never skip a failing test — document it and keep going.

OUTPUT FORMAT:
When done, write your findings to $QA_DIR/findings-{category}.json with this structure:
{
  "category": "{category}",
  "tests": [
    {
      "id": "TEST-{NNN}",
      "scenario": "description of what was tested",
      "steps": ["step 1", "step 2", ...],
      "result": "PASS" | "FAIL",
      "severity": "P0" | "P1" | "P2" | "P3" | null,
      "expected": "what should happen",
      "actual": "what actually happened (only if FAIL)",
      "screenshot": "filename.png",
      "console_errors": ["error text"] | [],
      "fix_hint": "suggestion for developer on what to fix (only if FAIL)"
    }
  ],
  "summary": { "passed": N, "failed": N }
}

Also save a human-readable summary to $QA_DIR/findings-{category}.md.
Close the browser when done.
```

## Per-agent testing mandates

**Agent 1: Happy Path** (category `happy-path`)
```
Test every primary user flow end-to-end. Prove the feature works as intended.
For each user-facing flow on this page:
1. Perform the complete action sequence with valid data
2. Verify the expected outcome (success message, navigation, data saved)
3. Verify no console errors during the flow
```

**Agent 2: Form & Input Validation** (category `forms`; at shallow depth keep it minimal — one negative case per form/action)
```
For every form and input field on the page, test systematically:

Required field validation:
- Submit with all fields empty
- Submit with each required field empty one at a time
- Verify error messages appear and are helpful

Input boundaries:
- Empty string, single char, max length (255, 1000, 10000 chars)
- Leading/trailing whitespace "  value  ", only whitespace "   "

Format validation (per field type):
- Email: not-an-email, @missing.com, user@, user@domain
- Numbers: negative, zero, decimals, huge values, letters
- Dates: impossible dates (Feb 30), boundary dates

Special characters (if depth is deep):
- Unicode: émojis 🎉, 中文, العربية
- XSS: <script>alert('xss')</script>
- SQL: '; DROP TABLE users; --
- HTML entities: &amp; &lt; &gt;

After each test: type/fill → trigger validation → snapshot → screenshot → clear
```

**Agent 3: Error States & Edge Cases** (category `error-states`)
```
Test everything that can go wrong or behave unexpectedly:

Empty states: page with no data — helpful message or blank void?
Loading states: interactions during loading
Duplicate submissions: click submit rapidly 5 times
Navigation: back button after submit, refresh mid-flow, direct deep URL, new tab
State persistence: partial form fill → navigate away → return; fill → refresh
Keyboard: Tab through all elements, Enter submits, Escape closes modals
Concurrent: two tabs same page, edit in one, check the other
```

**Agent 4: Accessibility** (category `a11y`; only with `--a11y` or depth=deep)
```
Audit accessibility using browser_snapshot (accessibility tree):

Semantic structure: exactly one h1, heading hierarchy (no skips), landmarks (main, nav, header, footer)
Form a11y: every input has a label, required fields have aria-required, errors linked via aria-describedby
Interactive elements: all buttons have accessible names, images have alt text, custom widgets use ARIA roles
Focus management: tab order is logical, modal focus trapping, focus return on close
Color/contrast: use browser_evaluate to check computed styles on key elements
```

**Agent 5: Responsive** (category `responsive`; only with `--responsive` or depth=deep)
```
Test at three breakpoints using browser_resize:
- Mobile: 375x812 (iPhone 13)
- Tablet: 768x1024 (iPad)
- Desktop: 1440x900 (Laptop)

At each: resize → snapshot → screenshot → check layout adapts, no horizontal scroll on mobile, touch targets ≥44px, text readable, nav collapses, tables reflow, modals usable
```

**Agent 6: Performance** (category `perf`; only with `--perf` or depth=deep)
```
Check performance metrics:
Network: browser_network_requests — flag requests >1MB, chains >3 sequential, failed 4xx/5xx, total count + size
Timing: browser_evaluate to read performance.getEntriesByType('navigation') — domContentLoaded, load, ttfb
Resources: browser_evaluate to find resources >500KB with name, size, duration
```
