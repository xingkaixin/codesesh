import { expect, test } from "./test-fixtures.js";

test.use({ timezoneId: "Asia/Tokyo" });

test("shows scoped active hours in the browser time zone", async ({ page }) => {
  await page.goto("/?range=all");
  const chart = page.getByRole("region", { name: "Active hours", exact: true });
  await expect(
    chart.getByRole("button", { name: "Mon · 18:00–20:00 · 3 user messages" }),
  ).toBeVisible();
  await expect(chart.getByText("Time zone: Asia/Tokyo")).toBeVisible();
  await page.goto("/projects?range=all");
  await page
    .locator("main")
    .getByRole("link", { name: /codesesh-e2e/ })
    .click();
  await expect(
    chart.getByRole("button", { name: "Mon · 18:00–20:00 · 3 user messages" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Claude Code 1" }).click();
  await expect(
    chart.getByRole("button", { name: "Mon · 18:00–20:00 · 2 user messages" }),
  ).toBeVisible();
});
