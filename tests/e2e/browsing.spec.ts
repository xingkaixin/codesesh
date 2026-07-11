import { expect, test } from "playwright/test";

test("covers dashboard, detail, search, projects, and pin flows", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  const resetBookmark = await page.request.delete("/api/bookmarks/claudecode/e2e-dashboard");
  expect(resetBookmark.ok()).toBe(true);

  await page.goto("/");
  const dashboard = page.getByTestId("dashboard");
  await expect(dashboard).toBeVisible();
  await expect(dashboard.getByText("Total Sessions")).toBeVisible();
  await expect(dashboard.getByText("Core browsing smoke session")).toBeVisible();

  await page
    .getByRole("link", { name: /Claude Code/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Claude Code" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /codesesh-e2e/ })).toBeVisible();

  await page.getByText("Core browsing smoke session").first().click();
  await expect(page).toHaveURL(/\/claudecode\/e2e-dashboard$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Core browsing smoke session" }),
  ).toBeVisible();
  await expect(page.getByText("Dashboard path is ready")).toBeVisible();

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/search?q=needle");
      const body = (await response.json()) as {
        results?: Array<{ session?: { title?: string } }>;
      };
      return body.results?.some(
        (result) => result.session?.title === "Core browsing smoke session",
      );
    })
    .toBe(true);

  await page.getByRole("searchbox", { name: "Search Sessions" }).fill("needle");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();

  const searchResult = page
    .getByRole("link")
    .filter({ hasText: "Core browsing smoke session" })
    .first();
  await expect(searchResult).toContainText("needle");
  await searchResult.click();
  await expect(page).toHaveURL(/\/claudecode\/e2e-dashboard$/);
  await expect(page.getByText("needle search target")).toBeVisible();

  await page.goto("/");
  const recentSession = page
    .locator("li")
    .filter({ hasText: "Core browsing smoke session" })
    .first();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/bookmarks");
      const body = (await response.json()) as { storageAvailable?: boolean };
      return body.storageAvailable === true;
    })
    .toBe(true);

  await recentSession.getByRole("button", { name: "收藏会话" }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/bookmarks");
      const body = (await response.json()) as {
        bookmarks?: Array<{ agentKey?: string; sessionId?: string }>;
      };
      return body.bookmarks?.some(
        (bookmark) => bookmark.agentKey === "claudecode" && bookmark.sessionId === "e2e-dashboard",
      );
    })
    .toBe(true);
  await expect(page.getByText("Bookmarked Sessions")).toBeVisible();
  await expect(recentSession.getByRole("button", { name: "取消收藏会话" })).toBeVisible();
  await expect(page.locator("section").filter({ hasText: "BOOKMARKS" })).toContainText(
    "Core browsing smoke session",
  );

  expect(consoleErrors).toEqual([]);
});

test("keeps detail drawers modal and restores focus", async ({ page }) => {
  await page.goto("/claudecode/e2e-dashboard");
  await expect(page.getByTestId("session-detail")).toBeVisible();

  const receiptTrigger = page.getByRole("button", { name: "Open session receipt" });
  await receiptTrigger.click();
  const receiptDialog = page.getByRole("dialog", { name: "Session Receipt" });
  await expect(receiptDialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  await expect(page.getByRole("button", { name: "Close session receipt" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => receiptDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(receiptDialog).toBeHidden();
  await expect(receiptTrigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");

  await page.setViewportSize({ width: 390, height: 844 });
  const tocTrigger = page.getByRole("button", { name: /^TOC/ });
  await tocTrigger.click();
  const tocDialog = page.getByRole("dialog", { name: "Session TOC" });
  await expect(tocDialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close session toc" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect.poll(() => tocDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(tocDialog).toBeHidden();
  await expect(tocTrigger).toBeFocused();

  await tocTrigger.click();
  await expect(tocDialog).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tocDialog).toBeHidden();
});
