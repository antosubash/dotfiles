# /vf — Stages 2b/2c: E2E spec author + run

Read by /vf only when e2e is configured and `--no-e2e` was not passed.

## 2b — Author/update the spec

Place it in the existing e2e directory using the project's conventions (naming, fixtures, helpers). Read 1–2 neighboring specs first so helpers/fixtures/imports match — don't introduce a new style. If a spec for this feature already exists, EXTEND it rather than duplicate. Stage the new/modified spec for commit.

JS/TS template (adapt to repo conventions):

```ts
// e2e/tests/<feature>.spec.ts
import { test, expect } from "@playwright/test";

test.describe("<feature name>", () => {
  test("renders and behaves correctly", async ({ page }) => {
    await page.goto("<route>");
    await expect(page).toHaveTitle(/<expected>/);
    await expect(page.getByRole("heading", { name: /<heading>/i })).toBeVisible();
    await page.getByRole("button", { name: /<cta>/i }).click();
    await expect(page).toHaveURL(/<post-action-route>/);

    // Async side effect (if a Stage 1b worker is involved): poll up to ~30s
    await expect(async () => {
      const r = await page.request.get("/api/<resource>");
      expect(r.ok()).toBeTruthy();
      expect((await r.json()).status).toBe("completed");
    }).toPass({ timeout: 30_000 });
  });

  test("no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("<route>");
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
});
```

- **.NET** (NUnit + `Microsoft.Playwright.NUnit`): under the existing `*.E2E.Tests` project, follow neighbor `[Test]` classes.
- **Python** (`pytest-playwright`): under `tests/e2e/`, `def test_<feature>(page):` style.

## 2c — Run only this spec (`--e2e-only PATH` overrides which spec)

| Stack | Command |
|-------|---------|
| JS/TS | `npx playwright test <spec> --reporter=list` (or `<pm> exec playwright test ...` if `e2e/` is its own workspace) |
| .NET | `dotnet test <E2E-project> --filter "FullyQualifiedName~<TestClass>"` |
| Python | `pytest <spec> -v` |

Pass criteria:
- The spec exits green.
- Console clean (the "no console errors" case).
- If Stage 1b started a worker: the async side-effect assertion passed, AND `$VF_DIR/worker.log` shows a success line for the job and no `exception`/`failed`/`error` lines.

Capture:
- Playwright HTML report summary line (e.g. `e2e/playwright-report/`) and `test-results/` traces → `$VF_DIR/`.
- Final passing screenshot from `test-results/.../*.png` → `$VF_DIR/screenshot.png`.
