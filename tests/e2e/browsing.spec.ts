import { expect, test } from "./test-fixtures.js";

test("opens a session detail from the project timeline", async ({ page }) => {
  await page.goto("/projects");
  await page
    .locator("main")
    .getByRole("link", { name: /codesesh-e2e/ })
    .first()
    .click();

  await page.getByRole("button", { name: /Core browsing smoke session/ }).click();
  await expect(page).toHaveURL(/\/claudecode\/e2e-dashboard$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Core browsing smoke session" }),
  ).toBeVisible();
  await expect(page.getByText("Dashboard path is ready")).toBeVisible();
});

test("searches indexed messages and opens a result", async ({ page }) => {
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

  await page.goto("/");
  await page.getByRole("button", { name: "Search Sessions" }).click();
  await page.getByRole("searchbox", { name: "Search Sessions" }).fill("needle");
  await page.getByRole("searchbox", { name: "Search Sessions" }).press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: /^Search/ })).toBeVisible();

  const searchResult = page
    .getByRole("link")
    .filter({ hasText: "Core browsing smoke session" })
    .first();
  await expect(searchResult).toContainText("needle");
  await searchResult.click();
  await expect(page).toHaveURL(/\/claudecode\/e2e-dashboard#message-1$/);
  await expect(page.getByText("needle search target")).toBeVisible();
  await expect(page.locator("#session-message-1-block-0")).toBeInViewport();
  await page.reload();
  await expect(page.locator("#session-message-1-block-0")).toBeInViewport();
});

test("bookmarks a recent session", async ({ page }) => {
  const resetBookmark = await page.request.delete("/api/bookmarks/claudecode/e2e-dashboard");
  expect(resetBookmark.ok()).toBe(true);

  await page.goto("/claudecode");
  const recentSession = page
    .locator("main")
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
        bookmarks?: Array<{
          reference?: { agentName?: string; sessionId?: string };
        }>;
      };
      return body.bookmarks?.some(
        (bookmark) =>
          bookmark.reference?.agentName === "claudecode" &&
          bookmark.reference.sessionId === "e2e-dashboard",
      );
    })
    .toBe(true);
  await expect(recentSession.getByRole("button", { name: "Remove bookmark" })).toBeVisible();
  await expect(
    page.locator("aside").locator("section").filter({ hasText: "BOOKMARKS" }),
  ).toContainText("Core browsing smoke session");
});

test("persists the selected time range across navigation", async ({ page }) => {
  await page.goto("/claudecode/e2e-dashboard?range=14d");

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Dashboard" })
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("14d");
  const range = page.getByRole("group", { name: "Session time range" });
  await expect(range.getByRole("button", { name: "14d" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(range.getByRole("button", { name: "14d" })).toHaveAttribute("aria-pressed", "true");

  await range.getByRole("button", { name: "Custom" }).click();
  const dialog = page.getByRole("dialog", { name: "Custom time range" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("From").fill("2026-04-01");
  await dialog.getByLabel("To").fill("2026-04-30");
  await dialog.getByRole("button", { name: "Apply range" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("custom");
  await expect.poll(() => new URL(page.url()).searchParams.get("from")).toBe("2026-04-01");
  await expect.poll(() => new URL(page.url()).searchParams.get("to")).toBe("2026-04-30");
});
