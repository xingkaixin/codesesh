import { expect, test } from "playwright/test";

test("keeps project navigation aligned with the overview route", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  const projectNavigation = page
    .locator("aside")
    .getByRole("link", { name: /codesesh-e2e/ })
    .first();
  await projectNavigation.click();
  await expect(page.getByRole("heading", { level: 1, name: "codesesh-e2e" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Projects" })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("Select a project")).toBeVisible();
  await expect(projectNavigation).not.toHaveClass(/bg-white/);
});

test("persists app shell preferences across reloads", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss keyboard shortcuts hint" }).click();

  await page.reload();

  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss keyboard shortcuts hint" })).toHaveCount(
    0,
  );
});

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
  const activityChart = page.getByRole("region", { name: "Daily Activity" });
  const activityBar = activityChart.getByRole("button").first();
  await activityBar.focus();
  await expect(activityBar).toBeFocused();
  await expect(activityChart.getByRole("table", { name: "Daily Activity data" })).toBeAttached();

  await page
    .getByRole("link", { name: /Claude Code/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Claude Code" })).toBeVisible();
  const projectTreeItem = page.getByRole("treeitem", { name: /codesesh-e2e/ });
  await expect(projectTreeItem).toBeVisible();
  await projectTreeItem.click();

  const treeSession = page.getByRole("treeitem", { name: /Core browsing smoke session/ });
  await treeSession.focus();
  await treeSession.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(treeSession).toBeFocused();

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
  const searchHeading = page.getByRole("heading", { level: 1, name: "Search" });
  await expect(searchHeading).toBeVisible();
  await expect(searchHeading.locator("..").locator("span")).toHaveText("Search");

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
    .getByTestId("dashboard")
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

  await recentSession.getByRole("button", { name: "Add bookmark" }).click();
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
  await expect(recentSession.getByRole("button", { name: "Remove bookmark" })).toBeVisible();
  await expect(page.locator("section").filter({ hasText: "BOOKMARKS" })).toContainText(
    "Core browsing smoke session",
  );

  expect(consoleErrors).toEqual([]);
});

test("persists the selected time range across navigation", async ({ page }) => {
  await page.goto("/claudecode/e2e-dashboard?range=14d");

  const range = page.getByRole("combobox", { name: "Session time range" });
  await expect(range).toHaveValue("14d");

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Dashboard" })
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("14d");
  await page.reload();
  await expect(range).toHaveValue("14d");

  await range.selectOption("custom");
  const dialog = page.getByRole("dialog", { name: "Custom time range" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.transitionProperty}|${style.transitionDuration}|${style.scale}`;
      }),
    )
    .toBe("opacity, scale|0.2s, 0.2s|1");
  await dialog.getByLabel("From").fill("2026-04-01");
  await dialog.getByLabel("To").fill("2026-04-30");
  await dialog.getByRole("button", { name: "Apply range" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("custom");
  await expect.poll(() => new URL(page.url()).searchParams.get("from")).toBe("2026-04-01");
  await expect.poll(() => new URL(page.url()).searchParams.get("to")).toBe("2026-04-30");
});

test("keeps the time range when opening a session", async ({ page }) => {
  await page.goto("/claudecode?range=custom&from=2026-04-01&to=2026-04-30");
  await expect(page.getByRole("combobox", { name: "Session time range" })).toHaveValue("custom");

  await page.getByText("Core browsing smoke session").first().click();

  await expect(page.getByRole("combobox", { name: "Session time range" })).toHaveValue("custom");
  await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("custom");
});

test("keeps detail drawers modal and restores focus", async ({ page }) => {
  await page.goto("/claudecode/e2e-dashboard");
  await expect(page.getByTestId("session-detail")).toBeVisible();

  const receiptTrigger = page.getByRole("button", { name: "Open session receipt" });
  await receiptTrigger.click();
  const receiptDialog = page.getByRole("dialog", { name: "Session Receipt" });
  await expect(receiptDialog).toBeVisible();
  await expect
    .poll(() =>
      receiptDialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.transitionProperty}|${style.transitionDuration}`;
      }),
    )
    .toBe("opacity, transform|0.2s, 0.26s");
  const receiptCanvas = receiptDialog.locator('canvas[aria-hidden="true"]');
  await expect(receiptCanvas).toBeVisible();
  await expect
    .poll(() =>
      receiptCanvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const dialog = canvas.closest('[role="dialog"]');
        const context = canvas.getContext("2d");
        const bounds = canvas.getBoundingClientRect();
        if (!dialog || !context || bounds.width === 0 || bounds.height === 0) return false;

        const dialogBounds = dialog.getBoundingClientRect();
        const sampleY = Math.min(
          canvas.height - 1,
          Math.round((64 / bounds.height) * canvas.height),
        );
        const alpha = context.getImageData(Math.floor(canvas.width / 2), sampleY, 1, 1).data[3];
        return (
          bounds.left >= dialogBounds.left - 0.5 &&
          bounds.right <= dialogBounds.right + 0.5 &&
          Boolean(alpha)
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
    .toBe("hidden");
  await expect(page.getByRole("button", { name: "Close session receipt" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => receiptDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(receiptDialog).toBeHidden();
  await expect(receiptTrigger).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
    .not.toBe("hidden");

  await page.setViewportSize({ width: 390, height: 844 });
  const tocTrigger = page.getByRole("button", { name: /^TOC/ });
  await tocTrigger.click();
  const tocDialog = page.getByRole("dialog", { name: "Session TOC" });
  await expect(tocDialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close session toc" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => tocDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(tocDialog).toBeHidden();
  await expect(tocTrigger).toBeFocused();

  await tocTrigger.click();
  await expect(tocDialog).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tocDialog).toBeHidden();
});

test("returns a dragged receipt to its resting position", async ({ page }) => {
  await page.goto("/claudecode/e2e-dashboard");
  await page.getByRole("button", { name: "Open session receipt" }).click();

  const receiptDialog = page.getByRole("dialog", { name: "Session Receipt" });
  const receiptCanvas = receiptDialog.locator('canvas[aria-hidden="true"]');
  const receiptHitSurface = page.locator(
    '[aria-label="Interactive thermal receipt with Verlet paper simulation"]',
  );
  await expect(receiptCanvas).toBeVisible();
  await expect(receiptHitSurface).toBeVisible();

  const readCanvasHash = () =>
    receiptCanvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) return 0;

      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        hash = Math.imul(hash ^ (pixels[index] ?? 0), 16777619);
        hash = Math.imul(hash ^ (pixels[index + 3] ?? 0), 16777619);
      }
      return hash >>> 0;
    });

  let previousHash: number | undefined;
  await expect
    .poll(
      async () => {
        const currentHash = await readCanvasHash();
        const stopped = currentHash === previousHash;
        previousHash = currentHash;
        return stopped;
      },
      { timeout: 7_000, intervals: [100] },
    )
    .toBe(true);
  const restingHash = await readCanvasHash();
  const hitBounds = await receiptHitSurface.boundingBox();
  expect(hitBounds).not.toBeNull();
  if (!hitBounds) return;

  const startX = hitBounds.x + hitBounds.width / 2;
  const startY = hitBounds.y + hitBounds.height * 0.75;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 90, startY + 20, { steps: 4 });
  await page.mouse.up();

  expect(await readCanvasHash()).not.toBe(restingHash);
  await expect.poll(readCanvasHash, { timeout: 7_000, intervals: [100] }).toBe(restingHash);
  await page.waitForTimeout(200);
  expect(await readCanvasHash()).toBe(restingHash);
});

test("renders a static receipt for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/claudecode/e2e-dashboard");
  await page.getByRole("button", { name: "Open session receipt" }).click();

  const receiptDialog = page.getByRole("dialog", { name: "Session Receipt" });
  await expect(receiptDialog).toBeVisible();
  await expect
    .poll(() =>
      receiptDialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.transitionProperty}|${style.transitionDuration}|${style.transform}`;
      }),
    )
    .toBe("opacity|0.15s|none");

  const receiptCanvas = receiptDialog.locator('canvas[aria-hidden="true"]');
  const receiptHitSurface = page.locator(
    '[aria-label="Interactive thermal receipt with Verlet paper simulation"]',
  );
  await expect(receiptCanvas).toBeVisible();
  await expect(receiptHitSurface).toBeHidden();
});
