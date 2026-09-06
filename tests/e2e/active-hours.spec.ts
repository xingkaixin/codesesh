import { expect, test } from "./test-fixtures.js";

test.use({ timezoneId: "Asia/Tokyo" });

for (const width of [1280, 375]) {
  test(`shows scoped active hours in the browser time zone at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?range=all");
    const chart = page.getByRole("region", { name: "Active hours", exact: true });
    await expect(
      chart.getByRole("button", { name: "Mon · 18:00–20:00 · 3 user messages" }),
    ).toBeVisible();
    await expect(chart.getByText("Time zone: Asia/Tokyo")).toBeVisible();
    await expect(chart.getByRole("button")).toHaveCount(84);
    await chart.getByRole("button", { name: "Mon · 18:00–20:00 · 3 user messages" }).click();
    await expect(chart.getByRole("tooltip")).toBeVisible();
    const bounds = await chart.getByRole("tooltip").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await chart.getByRole("heading").click();
    await chart.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.mouse.move(0, 0);
    await chart.screenshot({ path: testInfo.outputPath(`active-hours-${width}.png`) });
    await page.goto("/projects?range=all");
    await page
      .locator("main")
      .getByRole("link", { name: /codesesh-e2e/ })
      .click();
    await expect(
      chart.getByRole("button", { name: "Mon · 18:00–20:00 · 3 user messages" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Claude Code · 1" }).click();
    await expect(
      chart.getByRole("button", { name: "Mon · 18:00–20:00 · 2 user messages" }),
    ).toBeVisible();
  });
}
