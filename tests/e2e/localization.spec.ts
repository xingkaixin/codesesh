import { expect, test } from "./test-fixtures.js";

test.describe("localized product UI", () => {
  test.use({ locale: "zh-CN" });

  test("follows browser language and remembers manual switches without losing page state", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "概览" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const search = page.getByRole("searchbox", { name: "搜索会话" });
    await search.fill("Dashboard 日本語");
    await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("ja");
    await expect(page.getByRole("heading", { level: 1, name: "ダッシュボード" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "セッションを検索" })).toHaveValue(
      "Dashboard 日本語",
    );
    await expect(page.getByRole("combobox", { name: "セッションの期間" })).toHaveValue("all");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "ダッシュボード" })).toBeVisible();
    await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("system");
    await expect(page.getByRole("heading", { level: 1, name: "概览" })).toBeVisible();
  });

  test("localizes session controls while preserving original session content", async ({ page }) => {
    await page.goto("/claudecode/e2e-dashboard");
    await expect(
      page.getByRole("heading", { level: 1, name: "Core browsing smoke session" }),
    ).toBeVisible();
    await expect(page.getByText("Dashboard path is ready")).toBeVisible();
    await expect(page.getByRole("region", { name: "内容筛选" })).toBeVisible();
    await page.getByRole("checkbox", { name: "你的消息", exact: true }).uncheck();
    await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("ja");
    await expect(page).toHaveURL(/\/claudecode\/e2e-dashboard$/);
    await expect(page.getByRole("region", { name: "コンテンツフィルター" })).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "あなたのメッセージ", exact: true }),
    ).not.toBeChecked();
    await expect(page.getByText("Dashboard path is ready")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Core browsing smoke session" }),
    ).toBeVisible();
  });

  test("keeps language and navigation controls accessible on narrow screens", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("ja");
    await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
    await expect(page.getByRole("dialog", { name: "ナビゲーション", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});

test.describe("language fallback", () => {
  test.use({ locale: "fr-FR" });
  test("uses English for an unsupported browser language", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});
