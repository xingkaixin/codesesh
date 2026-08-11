import { expect, test } from "./test-fixtures.js";

function jsRequests(page: import("playwright/test").Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".js")) requested.push(path);
  });
  return requested;
}

/**
 * The dashboard must not pay for the session detail's markdown, syntax
 * highlighting or receipt — those arrive with the surface that needs them.
 */
test("loads detail-only chunks on demand", async ({ page }) => {
  const requested = jsRequests(page);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  const dashboardChunks = [...requested];

  await page.goto("/claudecode/e2e-dashboard");
  await expect(page.getByTestId("session-detail")).toBeVisible();
  await expect(page.getByText("Dashboard path is ready")).toBeVisible();

  const detailChunks = requested.filter((path) => !dashboardChunks.includes(path));

  // The dashboard never asked for the detail surface.
  expect(dashboardChunks.some((path) => /SessionDetail/i.test(path))).toBe(false);
  expect(dashboardChunks.some((path) => /PrismHighlighter/i.test(path))).toBe(false);
  expect(dashboardChunks.some((path) => /InteractiveReceipt/i.test(path))).toBe(false);
  // Opening it did.
  expect(detailChunks.some((path) => /SessionDetail/i.test(path))).toBe(true);
});

test("loads the receipt when its drawer opens", async ({ page }) => {
  const requested = jsRequests(page);

  await page.goto("/claudecode/e2e-dashboard");
  await expect(page.getByTestId("session-detail")).toBeVisible();
  expect(requested.some((path) => /InteractiveReceipt/i.test(path))).toBe(false);

  await page.getByRole("button", { name: "Open session receipt" }).click();

  await expect.poll(() => requested.some((path) => /InteractiveReceipt/i.test(path))).toBe(true);
});
