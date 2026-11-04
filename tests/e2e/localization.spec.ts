import type { Page } from "playwright/test";
import { expect, test } from "./test-fixtures.js";

async function chooseLanguage(page: Page, preferences: string, language: string) {
  await page.getByRole("button", { name: preferences }).click();
  await page.getByRole("menuitemradio", { name: language, exact: true }).click();
}

test.describe("localized product UI", () => {
  test.use({ locale: "zh-CN" });

  test("follows browser language and remembers manual switches without losing page state", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "概览" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "搜索会话" }).click();
    await page.getByRole("searchbox", { name: "搜索会话" }).fill("Dashboard 日本語");
    await chooseLanguage(page, "偏好设置", "日本語");
    await expect(page.getByRole("heading", { level: 1, name: /^検索/ })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "セッションを検索" })).toHaveValue(
      "Dashboard 日本語",
    );
    await expect(
      page.getByRole("group", { name: "セッションの期間" }).getByRole("button", { name: "すべて" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "ダッシュボード" })).toBeVisible();
    await chooseLanguage(page, "環境設定", "English");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await chooseLanguage(page, "Preferences", "Follow system");
    await expect(page.getByRole("heading", { level: 1, name: "概览" })).toBeVisible();
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
