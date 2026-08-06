import { expect, monitorBrowserErrors, test } from "./test-fixtures.js";

test("keeps production analytics out of development", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('script[src*="cloudflareinsights.com"]')).toHaveCount(0);
});

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

test("explores the interactive product preview", async ({ page }) => {
  await page.goto("/");
  const preview = page.locator("[data-product-demo]").last();
  const searchTab = preview.getByRole("tab", { name: "Structured Global Search" });
  const searchPanel = preview.getByRole("tabpanel", { name: "Structured Global Search" });

  await expect(preview.locator('img[src^="/demo/"]')).toHaveCount(0);
  await expect(preview).not.toContainText(/\bv\d+\.\d+\.\d+\b/);
  await searchTab.click();
  await expect(searchTab).toHaveAttribute("aria-selected", "true");
  await expect(searchPanel).toBeVisible();

  await preview.getByRole("textbox", { name: "Search sample sessions" }).fill("token budget");
  await preview.getByRole("button", { name: "Search", exact: true }).click();
  await expect(searchPanel).toContainText("3 matches for “token budget”");

  const replayTab = preview.getByRole("tab", { name: "Session Replay" });
  await replayTab.click();
  const toolStep = preview.getByRole("button", { name: "TOOL apply_patch" });
  await toolStep.click();
  await expect(toolStep).toHaveAttribute("aria-current", "true");

  await preview.getByRole("tab", { name: "Keyboard Navigation" }).click();
  await expect(preview.getByRole("dialog", { name: "Keyboard shortcuts preview" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(replayTab).toHaveAttribute("aria-selected", "true");
});

test("keeps the product preview usable on touch", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const browserErrors = monitorBrowserErrors(page);
  await page.goto("/");

  const preview = page.locator("[data-product-demo]").last();
  const searchTab = preview.getByRole("tab", { name: "Structured Global Search" });
  await searchTab.tap();
  await expect(preview.getByRole("tabpanel", { name: "Structured Global Search" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await context.close();
  expect(browserErrors, "unexpected browser errors").toEqual([]);
});

test("removes product preview animation for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const preview = page.locator("[data-product-demo]").last();
  await preview.getByRole("tab", { name: "Structured Global Search" }).click();
  await expect(preview.getByRole("tabpanel", { name: "Structured Global Search" })).toHaveCSS(
    "animation-name",
    "none",
  );
});
