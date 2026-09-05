import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/core/test-fixtures";
import { expect, test } from "./test-fixtures.js";

for (const width of [1280, 375]) {
  test(`keeps background refresh quiet and layout stable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/status*", (route) =>
      route.fulfill({ json: SAMPLE_SCAN_STATUS_EVENT }),
    );
    await page.addInitScript(() => {
      class TestEventSource extends EventTarget {
        private readonly onStatus = (event: Event) => {
          this.dispatchEvent(
            new MessageEvent("scan-status", {
              data: JSON.stringify((event as CustomEvent).detail),
            }),
          );
        };
        constructor() {
          super();
          window.addEventListener("test-scan-status", this.onStatus);
        }
        close() {
          window.removeEventListener("test-scan-status", this.onStatus);
        }
      }
      Object.defineProperty(window, "EventSource", { value: TestEventSource });
    });
    await page.goto("/");
    const dashboard = page.getByTestId("dashboard");
    await expect(dashboard.locator("section").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const initialTop = await dashboard.evaluate((element) => element.getBoundingClientRect().top);
    const notice = page.locator("p[title]").filter({ hasText: /session|history|index/i });
    for (const active of [true, false, true, false]) {
      await page.evaluate(
        (status) => {
          window.dispatchEvent(new CustomEvent("test-scan-status", { detail: status }));
        },
        {
          ...SAMPLE_SCAN_STATUS_EVENT,
          active,
          phase: active ? "scanning" : "idle",
          updatedAt: Date.now(),
        },
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(notice).toHaveCount(0);
      await expect(
        page.getByText("Checking for new or changed sessions", { exact: false }),
      ).toHaveCount(0);
      await expect
        .poll(() => dashboard.evaluate((element) => element.getBoundingClientRect().top))
        .toBe(initialTop);
    }
    for (const [phase, label] of [
      ["initializing", "Initializing recent sessions"],
      ["failed", "Session refresh failed"],
    ] as const) {
      await page.evaluate(
        (status) => {
          window.dispatchEvent(new CustomEvent("test-scan-status", { detail: status }));
        },
        {
          ...SAMPLE_SCAN_STATUS_EVENT,
          active: phase === "initializing",
          phase: phase === "initializing" ? "initializing" : "idle",
          updatedAt: Date.now(),
          agentStatuses:
            phase === "failed"
              ? {
                  codex: {
                    agentName: "codex",
                    status: "failed",
                    error: "read failed",
                    updatedAt: Date.now(),
                  },
                }
              : {},
        },
      );
      await expect(notice).toContainText(label);
      await expect(notice).toBeVisible();
      expect(await dashboard.evaluate((element) => element.getBoundingClientRect().top)).toBe(
        initialTop,
      );
    }
  });
}
