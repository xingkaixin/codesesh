import { expect, test } from "playwright/test";

test("copies the install command with the clipboard API", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  });
  await page.goto("/");

  const copy = page.locator("[data-copy-command]");
  await copy.click();

  await expect(copy).toContainText("Copied");
});

test("reports copy failure without an unhandled rejection", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  await page.goto("/");

  const copy = page.locator("[data-copy-command]");
  await copy.click();

  await expect(copy).toContainText("Copy failed");
  await expect(page.locator("[data-copy-status]")).toHaveText(
    "Copy failed. Copy the command manually.",
  );
  expect(pageErrors).toEqual([]);
});

test("falls back when the clipboard API rejects", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => true,
    });
  });
  await page.goto("/");

  const copy = page.locator("[data-copy-command]");
  await copy.click();

  await expect(copy).toContainText("Copied");
});

test("navigates showcase dialogs", async ({ page }) => {
  await page.goto("/");
  const expand = page.getByRole("button", { name: "Expand Engineering Memory Overview" });
  await expand.locator("xpath=ancestor::article").hover();
  await expect(expand).toHaveCSS("opacity", "1");
  await expand.focus();
  await expect(expand).toBeFocused();
  await expect(expand).toHaveCSS("opacity", "1");
  await expand.click();
  const first = page.getByRole("dialog", {
    name: "Engineering Memory Overview preview",
  });
  await expect(first).toBeVisible();

  await first.getByRole("button", { name: "Next" }).click();
  const next = page.getByRole("dialog", {
    name: "Structured Global Search preview",
  });
  await expect(next).toBeVisible();

  await next.getByRole("button", { name: "Previous" }).click();
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "Close" }).click();
  await expect(first).toBeHidden();
});

test("keeps showcase actions visible on touch", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/");

  const expand = page.getByRole("button", { name: "Expand Engineering Memory Overview" });
  await expect(expand).toHaveCSS("opacity", "1");
  await expand.tap();
  await expect(page.getByRole("dialog", { name: "Engineering Memory Overview preview" })).toBeVisible();
  await context.close();
});

test("removes showcase transforms for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const expand = page.getByRole("button", { name: "Expand Engineering Memory Overview" });
  await expand.hover();
  await expect(expand).toHaveCSS("transform", "none");
});
