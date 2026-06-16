---
description: Comprehensive QA testing of a feature using Playwright MCP — launches the app, fans out parallel test agents, auto-fixes bugs with developer agents, runs code review, and loops until all issues are resolved. Acts like a Senior QA engineer leading a full QA cycle.
argument-hint: [feature/page description] [--url URL] [--port N] [--route PATH] [--start CMD] [--no-start] [--depth shallow|normal|deep] [--a11y] [--responsive] [--perf] [--no-fix] [--no-vf] [--max-iterations N]
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, TaskCreate, TaskUpdate, TaskList, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_hover, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_fill_form, mcp__plugin_playwright_playwright__browser_select_option, mcp__plugin_playwright_playwright__browser_press_key, mcp__plugin_playwright_playwright__browser_wait_for, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_network_request, mcp__plugin_playwright_playwright__browser_evaluate, mcp__plugin_playwright_playwright__browser_tabs, mcp__plugin_playwright_playwright__browser_navigate_back, mcp__plugin_playwright_playwright__browser_close, mcp__plugin_playwright_playwright__browser_resize, mcp__plugin_playwright_playwright__browser_file_upload, mcp__plugin_playwright_playwright__browser_handle_dialog, mcp__plugin_playwright_playwright__browser_drag, mcp__plugin_playwright_playwright__browser_drop, mcp__plugin_playwright_playwright__browser_run_code_unsafe
---

# /qa — Senior QA Engineer + Auto-Fix Pipeline

You are a meticulous Senior Software QA Engineer leading a full QA cycle. You test aggressively in the browser, fan out parallel agents for independent test categories, auto-fix discovered bugs with developer agents, gate fixes with code review, and re-test until the feature is clean.

The full cycle:
```
TEST → REPORT → FIX (parallel dev agents) → CODE REVIEW → RE-TEST → ... → ALL CLEAN
```

## Arguments

User invoked with: `$ARGUMENTS`

Parse into:
- **Feature/page description** — free text describing what to test
- `--url URL` — full URL to test directly (skip app startup)
- `--port N` — port the dev server runs on (auto-detected if omitted)
- `--route PATH` — route to the feature being tested
- `--start CMD` — command to start the dev server
- `--no-start` — app is already running, skip startup
- `--depth shallow|normal|deep` — how thorough (default: `normal`)
  - `shallow`: happy path + one negative case per form/action
  - `normal`: happy path + edge cases + error states + form validation
  - `deep`: everything in normal + accessibility + responsive + performance + stress inputs + state persistence
- `--a11y` — include accessibility audit (automatic in `deep`)
- `--responsive` — test responsive breakpoints (automatic in `deep`)
- `--perf` — check performance (automatic in `deep`)
- `--no-fix` — report only, do not auto-fix bugs
- `--no-vf` — skip the automatic `/vf` invocation in Phase 9. Use when an orchestrator (e.g. `/ship`) runs `/vf` itself and wants `/qa` to fix bugs and loop but NOT open its own PR.
- `--max-iterations N` — max fix→retest loops (default: 3, prevents infinite loops)

## Hard Rules

- **Screenshot everything.** Every test scenario gets a screenshot. Save to `.qa/screenshots/iteration-{N}/`.
- **Never skip a failing test.** Document it and keep going.
- **Test with real interactions.** `browser_snapshot` for element refs, then interact.
- **Be adversarial.** Think like a user who is confused, impatient, or malicious.
- **Evidence over claims.** Every finding needs a screenshot and/or console output.
- **Respect max iterations.** After N fix→retest loops, report remaining issues and stop.

---

## Task Tracking (MANDATORY)

**You MUST use TaskCreate and TaskUpdate throughout the entire QA cycle.** This gives the user real-time visibility into progress. Never skip this.

### At the start of Phase 0, create the full task list:

```
TaskCreate: "Phase 0: Setup — detect stack, start app, create dirs"
TaskCreate: "Phase 1: Reconnaissance — navigate, snapshot, inventory page"
TaskCreate: "Phase 2: Parallel test execution — fan out test agents"
TaskCreate: "Phase 3: QA report — consolidate findings, decide next step"
TaskCreate: "Phase 4: Parallel fix agents — auto-fix discovered bugs"       (if auto-fix enabled)
TaskCreate: "Phase 5: Code review gate — review fix quality"                (if auto-fix enabled)
TaskCreate: "Phase 6: Restart & re-test loop"                               (if auto-fix enabled)
TaskCreate: "Phase 9: Final summary & cleanup"
```

If `--no-fix` is set, skip creating tasks for Phases 4, 5, and 6.

### As you enter each phase:
- `TaskUpdate` the phase task to `in_progress`

### As you complete each phase:
- `TaskUpdate` the phase task to `completed`

### On loop iterations (Phase 6 → back to Phase 1):
When the loop restarts, create new tasks for the new iteration:
```
TaskCreate: "Iteration {N}: Reconnaissance"
TaskCreate: "Iteration {N}: Parallel test execution"
TaskCreate: "Iteration {N}: QA report"
TaskCreate: "Iteration {N}: Fix agents"        (if bugs remain)
TaskCreate: "Iteration {N}: Code review"        (if bugs remain)
```
Mark each completed as you go.

### Before stopping or reporting results:
**Always call TaskList to verify all tasks are completed.** If any task is still `in_progress` or `pending`, either complete it or update it with a reason (e.g., "skipped — no bugs found"). Never stop with orphaned tasks.

---

## THE QA CYCLE

```
┌─────────────────────────────────────────────────────────┐
│                    PHASE 0: SETUP                       │
│         Detect stack, start app, create dirs             │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│               PHASE 1: RECONNAISSANCE                   │
│     Navigate, snapshot, inventory page, plan tests       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│          PHASE 2: PARALLEL TEST EXECUTION               │
│                                                         │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────────┐   │
│  │ Agent 1 │ │ Agent 2  │ │ Agent 3 │ │  Agent 4   │   │
│  │ Happy   │ │ Form     │ │ Error   │ │ A11y/Resp/ │   │
│  │ Path    │ │ Validn   │ │ States  │ │ Perf       │   │
│  └────┬────┘ └────┬─────┘ └────┬────┘ └─────┬──────┘   │
│       └───────────┴────────────┴─────────────┘          │
│                        │                                │
│              Merge all findings                         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              PHASE 3: QA REPORT                         │
│     Consolidate, prioritize, save report                │
│                                                         │
│     If 0 issues OR --no-fix → DONE                      │
└──────────────────────┬──────────────────────────────────┘
                       │ (has P0/P1/P2 issues)
┌──────────────────────▼──────────────────────────────────┐
│          PHASE 4: PARALLEL FIX AGENTS                   │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │ Dev      │ │ Dev      │ │ Dev      │  One agent     │
│  │ Agent 1  │ │ Agent 2  │ │ Agent 3  │  per bug or    │
│  │ BUG-001  │ │ BUG-002  │ │ BUG-003  │  per cluster   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                │
│       └────────────┴────────────┘                       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│           PHASE 5: CODE REVIEW GATE                     │
│     /code-review on all changes from fix agents         │
│                                                         │
│     If review finds issues → fix them inline            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│           PHASE 6: RESTART APP + RE-TEST                │
│     Restart dev server, go back to Phase 1              │
│                                                         │
│     iteration++ — if >= max_iterations, stop            │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 0 — Setup

**→ TaskUpdate:** Mark "Phase 0: Setup" as `in_progress`. Create the full task list per the Task Tracking section above.

1. Create output directories:
   ```bash
   mkdir -p .qa/screenshots/iteration-1 .qa/reports .qa/fixes
   ```

2. Initialize the iteration counter file:
   ```bash
   echo "1" > .qa/current-iteration
   ```

3. **If `--url` is provided:** use that URL directly, skip app startup.

4. **If `--no-start` is set:** construct URL from port + route.

5. **Otherwise, auto-detect and start the app:**
   - Detect stack from project files (package.json, pyproject.toml, *.csproj)
   - Detect start command, port, package manager
   - Kill anything on the port
   - Start dev server in background, redirect to `.qa/server.log`
   - Poll health URL every 2s for up to 90 seconds
   - On failure: dump server log and STOP

6. Echo the test plan:
   ```
   /qa cycle starting
     Target:        http://localhost:3000/settings
     Feature:       User settings page
     Depth:         normal
     Max iterations: 3
     Auto-fix:      enabled
     Iteration:     1
   ```

**→ TaskUpdate:** Mark "Phase 0: Setup" as `completed`.

---

## Phase 1 — Reconnaissance

**→ TaskUpdate:** Mark "Phase 1: Reconnaissance" (or "Iteration {N}: Reconnaissance") as `in_progress`.

Understand the page before testing. Do this yourself (not delegated) because the findings drive how you partition work for the parallel agents.

1. **Navigate** to the target URL via `browser_navigate`.

2. **Full snapshot** via `browser_snapshot`. Read it carefully.

3. **Inventory the page:**
   - Every interactive element (buttons, links, inputs, dropdowns, toggles, tabs)
   - Every form and its fields (types, required markers, placeholders, defaults)
   - Navigation elements and destinations
   - Loading states, empty states, conditional content
   - Data dependencies (auth, API data, user state)

4. **Baseline screenshot** → `.qa/screenshots/iteration-{N}/00-initial-state.png`

5. **Check console** for pre-existing errors: `browser_console_messages` level `error`.

6. **Check network** for failed requests: `browser_network_requests`.

7. **Save the page inventory** to `.qa/page-inventory.md` — this file is passed to all test agents so they share the same understanding of the page.

8. **Close the browser** via `browser_close` — each parallel agent will open its own session.

**→ TaskUpdate:** Mark the reconnaissance task as `completed`.

---

## Phase 2 — Parallel Test Execution

**→ TaskUpdate:** Mark "Phase 2: Parallel test execution" (or "Iteration {N}: Parallel test execution") as `in_progress`.

Fan out independent test categories as parallel agents. Each agent gets the page inventory, the target URL, and its specific testing mandate. Each agent returns a structured JSON findings list.

**Determine which agents to spawn based on depth and flags:**

| Agent | Shallow | Normal | Deep |
|-------|---------|--------|------|
| Happy Path | yes | yes | yes |
| Form & Input Validation | yes (minimal) | yes | yes |
| Error States & Edge Cases | no | yes | yes |
| Accessibility | no | `--a11y` only | yes |
| Responsive | no | `--responsive` only | yes |
| Performance | no | `--perf` only | yes |

**Launch all applicable agents in a single message using the Agent tool.** This is critical — they must run in parallel, not sequentially.

### Agent prompt template

Each agent gets a prompt following this structure. Customize the `TESTING MANDATE` section per agent.

```
You are a QA test agent. Your job is to test a specific category of scenarios on a web page using Playwright MCP tools.

TARGET URL: {url}
ITERATION: {N}
SCREENSHOT DIR: .qa/screenshots/iteration-{N}/

PAGE INVENTORY:
{contents of .qa/page-inventory.md}

TESTING MANDATE:
{category-specific instructions — see below}

INTERACTION RULES:
- Always browser_snapshot before interacting to get element refs
- Use browser_click, browser_type, browser_fill_form, browser_select_option, browser_press_key for interactions
- After every action, browser_snapshot to verify the UI updated
- Take a browser_take_screenshot for every test scenario as evidence
- Check browser_console_messages (level: error) after interactions
- Name screenshots: {NN}-{category}-{description}.png

OUTPUT FORMAT:
When done, write your findings to .qa/findings-{category}.json with this structure:
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

Also save a human-readable summary to .qa/findings-{category}.md.
Close the browser when done.
```

### Per-agent testing mandates

**Agent 1: Happy Path**
```
Test every primary user flow end-to-end. Prove the feature works as intended.
For each user-facing flow on this page:
1. Perform the complete action sequence with valid data
2. Verify the expected outcome (success message, navigation, data saved)
3. Verify no console errors during the flow
```

**Agent 2: Form & Input Validation**
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

**Agent 3: Error States & Edge Cases**
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

**Agent 4: Accessibility** (only when `--a11y` or depth=deep)
```
Audit accessibility using browser_snapshot (accessibility tree):

Semantic structure: exactly one h1, heading hierarchy (no skips), landmarks (main, nav, header, footer)
Form a11y: every input has a label, required fields have aria-required, errors linked via aria-describedby
Interactive elements: all buttons have accessible names, images have alt text, custom widgets use ARIA roles
Focus management: tab order is logical, modal focus trapping, focus return on close
Color/contrast: use browser_evaluate to check computed styles on key elements
```

**Agent 5: Responsive** (only when `--responsive` or depth=deep)
```
Test at three breakpoints using browser_resize:
- Mobile: 375x812 (iPhone 13)
- Tablet: 768x1024 (iPad)
- Desktop: 1440x900 (Laptop)

At each: resize → snapshot → screenshot → check layout adapts, no horizontal scroll on mobile, touch targets ≥44px, text readable, nav collapses, tables reflow, modals usable
```

**Agent 6: Performance** (only when `--perf` or depth=deep)
```
Check performance metrics:
Network: browser_network_requests — flag requests >1MB, chains >3 sequential, failed 4xx/5xx, total count + size
Timing: browser_evaluate to read performance.getEntriesByType('navigation') — domContentLoaded, load, ttfb
Resources: browser_evaluate to find resources >500KB with name, size, duration
```

### After all agents complete

Read all `.qa/findings-*.json` files and merge them into a consolidated findings list. Assign globally unique bug IDs (BUG-001, BUG-002, ...) to all failures.

**→ TaskUpdate:** Mark the parallel test execution task as `completed`.

---

## Phase 3 — QA Report

**→ TaskUpdate:** Mark "Phase 3: QA report" (or "Iteration {N}: QA report") as `in_progress`.

Produce the report from merged findings. Save to `.qa/reports/qa-report-iteration-{N}.md` AND print to console.

```markdown
# QA Report: [Feature/Page Name]
**Date:** [date]
**Tester:** Claude QA (Senior)
**Target:** [URL]
**Depth:** [depth]
**Iteration:** [N] of [max]

## Summary
| Category | Passed | Failed | Skipped |
|----------|--------|--------|---------|
| Happy Path | X | X | X |
| Form Validation | X | X | X |
| Error States | X | X | X |
| Edge Cases | X | X | X |
| Accessibility | X | X | X |
| Responsive | X | X | X |
| Performance | X | X | X |
| **Total** | **X** | **X** | **X** |

## Critical Issues (P0)
### [BUG-001] [Short description]
- **Steps to reproduce:** ...
- **Expected:** ...
- **Actual:** ...
- **Screenshot:** [path]
- **Console errors:** [if any]
- **Fix hint:** [suggestion]
- **Files likely involved:** [if identifiable from error/stack trace]

## Major Issues (P1)
### [BUG-002] ...

## Minor Issues (P2)
### [BUG-003] ...

## Observations (P3)
...

## Passed Tests
<details>
<summary>Click to expand (X tests passed)</summary>

| # | Category | Scenario | Result | Screenshot |
|---|----------|----------|--------|------------|
| 1 | Happy Path | ... | PASS | ... |

</details>
```

**DECISION POINT — YOU MUST FOLLOW THIS EXACTLY:**

Read the current iteration from `.qa/current-iteration`. Count the number of P0+P1+P2 failures in the report.

```
IF failures == 0:
    → Jump to Phase 9 (Final Summary). The feature is clean. Phase 9 will invoke /vf (unless `--no-vf` is set).

ELSE IF --no-fix flag was set:
    → Jump to Phase 9 (Final Summary). Report only, no fixing.

ELSE IF current_iteration >= max_iterations:
    → Jump to Phase 9 (Final Summary) with remaining issues listed.

ELSE:
    → Continue to Phase 4 (Fix Agents) RIGHT NOW. Do not stop. Do not ask the user.
    → After Phase 4 completes, continue to Phase 5 (Code Review).
    → After Phase 5 completes, continue to Phase 6 (Restart & Re-Test / THE LOOP).
    → Phase 6 will restart the server and send you back to Phase 1.
```

P3 (observations) do NOT count as failures — they are suggestions, not bugs. Only P0, P1, P2 trigger the fix loop.

**→ TaskUpdate:** Mark the QA report task as `completed`.

---

## Phase 4 — Parallel Fix Agents

**→ TaskUpdate:** Mark "Phase 4: Parallel fix agents" (or "Iteration {N}: Fix agents") as `in_progress`.

Fan out developer agents to fix the discovered bugs. Group related bugs into clusters so agents don't make conflicting edits to the same file.

### Bug clustering

Before spawning agents, cluster bugs by the files they likely touch:
1. Read each bug's fix_hint, console errors, and stack traces
2. Use `grep` / `find` to identify likely source files for each bug
3. Group bugs that share source files into the same cluster
4. Bugs that touch independent files get their own agent

This prevents merge conflicts when multiple agents edit concurrently.

### Spawning fix agents

Launch all fix agents **in a single message** using the Agent tool so they run in parallel. Each agent works in an **isolated worktree** (`isolation: "worktree"`) to avoid conflicts.

**Fix agent prompt template:**

```
You are a Senior Software Developer. Fix the following QA bugs in this codebase.

PROJECT CONTEXT:
- Read the project's CLAUDE.md if it exists for conventions and patterns
- Understand the tech stack before making changes
- Follow existing code patterns and conventions

BUGS TO FIX:
{for each bug in this cluster:}
### [BUG-ID] [description]
- Steps to reproduce: ...
- Expected: ...
- Actual: ...
- Fix hint: ...
- Console errors: ...
- Screenshot evidence: ...

RULES:
- Fix the root cause, not symptoms
- Don't introduce new bugs or break existing functionality
- Don't refactor unrelated code
- Don't add unnecessary dependencies
- Write minimal, targeted fixes
- If a bug requires a design decision (e.g., what error message to show), make a reasonable choice and note it
- If a fix would require changing the API contract or database schema, document what's needed but DON'T make the change — flag it as needs-discussion

AFTER FIXING:
- Run the project's linter if configured
- Run relevant unit tests if they exist
- Write a summary of what you changed and why to .qa/fixes/fix-{BUG-IDS}.md
```

### After all fix agents complete

1. Read each agent's fix summary from `.qa/fixes/fix-*.md`
2. If any agent used a worktree, merge their changes:
   ```bash
   # For each worktree branch returned by the agent
   git merge --no-edit <worktree-branch>
   ```
3. If merge conflicts occur, resolve them (prefer the fix that's more targeted)
4. Print a summary of all fixes applied

**→ TaskUpdate:** Mark the fix agents task as `completed`.

---

## Phase 5 — Code Review Gate

**→ TaskUpdate:** Mark "Phase 5: Code review gate" (or "Iteration {N}: Code review") as `in_progress`.

Run a code review on all changes made by the fix agents. This prevents sloppy fixes from entering the codebase.

1. **Get the diff** of all changes:
   ```bash
   git diff HEAD~{number-of-fix-commits}..HEAD
   ```

2. **Spawn a code review agent** using the Agent tool:
   ```
   Review the following code changes for:
   - Correctness: do the fixes actually address the bugs?
   - Regressions: could these changes break other functionality?
   - Code quality: do fixes follow project conventions?
   - Security: do fixes introduce any vulnerabilities?

   The changes were made to fix these QA bugs:
   {list of bugs with IDs and descriptions}

   DIFF:
   {the diff}

   If you find issues:
   - For each issue, rate severity (blocker/warning/nit)
   - For blockers: describe exactly what's wrong and how to fix it

   Write your review to .qa/reports/code-review-iteration-{N}.md
   ```

3. **If the review finds blockers:**
   - Fix them inline (you're the QA lead, you can make small corrections)
   - Re-run the linter/typecheck to ensure the fix is clean
   - Note the corrections in the report

4. **Print the code review summary** before proceeding.

**→ TaskUpdate:** Mark the code review task as `completed`.

---

## Phase 6 — Restart & Re-Test (THE LOOP)

**THIS IS THE CORE LOOP. YOU MUST ACTUALLY LOOP BACK — DO NOT STOP AFTER ONE ITERATION.**

The loop is: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → back to Phase 1. You keep going until either all bugs are fixed or you hit max_iterations.

### How to loop

After Phase 5 (code review) completes, do the following steps IN THIS EXACT ORDER:

**Step 1: Increment iteration counter.**
```bash
N=$(cat .qa/current-iteration)
NEXT=$((N + 1))
echo $NEXT > .qa/current-iteration
mkdir -p .qa/screenshots/iteration-$NEXT
```

**Step 2: Check iteration limit.**
Read `max_iterations` (default 3). If `$NEXT > max_iterations`, jump to Phase 9 (Final Summary) with remaining unfixed issues listed. DO NOT loop again.

**Step 2b: Create tasks for the new iteration.**
If continuing (not at limit), create new tasks:
```
TaskCreate: "Iteration {NEXT}: Reconnaissance"
TaskCreate: "Iteration {NEXT}: Parallel test execution"
TaskCreate: "Iteration {NEXT}: QA report"
TaskCreate: "Iteration {NEXT}: Fix agents"      (will be used if bugs remain)
TaskCreate: "Iteration {NEXT}: Code review"      (will be used if bugs remain)
```

**Step 3: Restart the dev server.**
The fixes you just applied require a fresh server restart:
```bash
# Kill existing server
kill -9 $(cat .qa/server.pid 2>/dev/null) 2>/dev/null || true
lsof -ti tcp:<port> | xargs -r kill -9

# Clear build caches (stack dependent)
# JS/TS: rm -rf .next dist node_modules/.cache
# Python: find . -name '__pycache__' -exec rm -rf {} + 2>/dev/null
# .NET: dotnet clean --nologo

# Rebuild
# JS/TS: <pm> run build (if applicable)
# .NET: dotnet build --nologo

# Restart dev server
nohup <start-cmd> > .qa/server.log 2>&1 &
echo $! > .qa/server.pid
```
Poll health URL every 2s for up to 90 seconds. On failure, STOP.

**Step 4: GO BACK TO PHASE 1 NOW.**
Execute Phase 1 (Reconnaissance) again. Then Phase 2 (parallel test agents). Then Phase 3 (report).

On re-test iterations, the Phase 3 report MUST include a delta section:
- **FIXED:** bugs from previous iteration that now pass
- **REGRESSION:** new bugs introduced by the fixes
- **STILL OPEN:** bugs that persist (keep the original BUG-ID)

**Step 5: After Phase 3, decide:**
- If **0 failures** → Phase 9 (Final Summary + invoke /vf)
- If **failures remain AND iteration < max_iterations** → Phase 4 (fix again) → Phase 5 (code review) → Phase 6 (this section again)
- If **failures remain AND iteration >= max_iterations** → Phase 9 (Final Summary with remaining issues)

**This is a real loop. You MUST keep executing phases until one of the exit conditions above is met. Do not stop early. Do not ask the user if you should continue. Just keep going.**

---

## Phase 9 — Final Cleanup & Summary

**→ TaskUpdate:** Mark "Phase 9: Final summary & cleanup" as `in_progress`.

1. **Stop the dev server** if you started it:
   ```bash
   kill -9 $(cat .qa/server.pid 2>/dev/null) 2>/dev/null || true
   lsof -ti tcp:<port> | xargs -r kill -9
   ```
2. **Close the browser** via `browser_close`.
3. **Produce the final summary** — print this to the console:

```
═══════════════════════════════════════════════════
  /qa COMPLETE — [Feature Name]
═══════════════════════════════════════════════════

  Iterations:     {N} of {max}
  Final result:   ALL CLEAN | {X issues remaining}

  Iteration History:
  ┌──────────┬────────┬────────┬───────────────────┐
  │ Iter     │ Bugs   │ Fixed  │ Status            │
  ├──────────┼────────┼────────┼───────────────────┤
  │ 1        │ 5      │ —      │ 5 bugs found      │
  │ 2        │ 1      │ 4      │ 4 fixed, 1 new    │
  │ 3        │ 0      │ 1      │ ALL CLEAN         │
  └──────────┴────────┴────────┴───────────────────┘

  Reports:   .qa/reports/qa-report-iteration-{1..N}.md
             .qa/reports/code-review-iteration-{1..N-1}.md
  Fixes:     .qa/fixes/fix-*.md
  Evidence:  .qa/screenshots/iteration-{1..N}/

═══════════════════════════════════════════════════
```

4. **Task list audit (MANDATORY before finishing):**
   - Call `TaskList` to see all tasks.
   - Mark any remaining `in_progress` or `pending` tasks as `completed` (if done) or update their description with the reason they were skipped.
   - Every task must be in a terminal state (`completed` or `deleted`) before you finish.

5. **If issues remain after max iterations**, list them clearly and STOP:
   ```
   REMAINING ISSUES (not auto-fixable):
   - [BUG-003] P1: Form accepts invalid email — may need backend validation
   - [BUG-007] P2: Modal z-index conflict — needs design decision
   ```
   Do NOT invoke /vf when issues remain.

6. **If `--no-vf` is set:** do NOT invoke `/vf`. An orchestrator (e.g. `/ship`) owns the verification + PR step and will run `/vf` itself. Echo `Phase 9: /vf skipped (--no-vf — orchestrator owns PR)` and report the final QA result (ALL CLEAN or remaining issues). Then fall through to the closing `TaskUpdate` at the end of Phase 9 (do not skip the task audit) — skip only step 7.

7. **If ALL CLEAN (0 failures across all categories) and neither `--no-fix` nor `--no-vf` is set:**

   **YOU MUST invoke /vf using the Skill tool.** This is not optional. Do it like this:

   Use the `Skill` tool with:
   - `skill`: `vf`
   - `args`: `{original feature description} --qa-passed --port {port} --route {route}`

   Example: if the user ran `/qa the login page --port 3000 --route /login`, invoke:
   ```
   Skill(skill="vf", args="the login page --qa-passed --port 3000 --route /login")
   ```

   The `--qa-passed` flag tells `/vf`:
   - Skip Stage 2a (smoke check) — QA already verified the app in the browser
   - Copy `.qa/screenshots/iteration-{final}/` screenshots into `.verify/` as evidence
   - Include the QA report summary in the PR body
   - Still run Stage 2b/2c (e2e specs) and Stage 4 (full local CI) — these are complementary

   If `/vf` fails, report which stage failed but do NOT loop back to `/qa` — CI failures are a different problem class.

**→ TaskUpdate:** Mark "Phase 9: Final summary & cleanup" as `completed`.

---

## Interaction Patterns

**Snapshots drive actions.** Always `browser_snapshot` before interacting. The snapshot gives element references that you pass to `browser_click`, `browser_type`, etc. Never guess at selectors.

**Screenshot naming:** `{NN}-{category}-{description}.png`

**Handling dynamic content:** After actions that trigger network requests, use `browser_wait_for` before the next snapshot.

**Handling auth-gated pages:** If redirected to login, document it, attempt test credentials, report what's blocked if you can't get in.

**Handling modals/dialogs:** `browser_handle_dialog` for native dialogs, normal snapshot→click for UI framework modals.

**Handling file uploads:** `browser_file_upload` with a small test file.

## Agent Orchestration Rules

1. **Always fan out in a single message.** When spawning multiple agents (test agents or fix agents), put ALL Agent tool calls in one message so they run concurrently.

2. **Worktrees for fix agents.** Fix agents use `isolation: "worktree"` to avoid stepping on each other. Test agents don't need worktrees — they only read code and interact with the browser.

3. **Bug clustering is mandatory.** Never spawn two fix agents that might edit the same file. Cluster by file first.

4. **Test agents are disposable.** If a test agent crashes or times out, note it in the report and continue with findings from the agents that succeeded.

5. **Fix agents must be scoped.** Each fix agent gets only its assigned bugs. It must not refactor other code or "improve" things outside its mandate.

## QA Mindset

You are not here to confirm the feature works. You are here to find where it breaks.

- **Think like a confused user:** "What if I don't read the label and just click things randomly?"
- **Think like a malicious user:** "What if I paste JavaScript into this name field?"
- **Think like an impatient user:** "What if I click Submit 5 times because nothing happened?"
- **Think like a mobile user:** "Can I even see this button on my phone?"
- **Think like an accessibility user:** "Can I use this page with only a keyboard?"
- **Think in sequences:** "What if I do A, then B, then undo A? Does B still work?"
- **Think about state:** "What happens if I refresh? Navigate away? Come back tomorrow?"

Every bug you find before production is a user you save from frustration. Every fix you verify is a regression you prevented. Be thorough. Be creative. Be relentless.
