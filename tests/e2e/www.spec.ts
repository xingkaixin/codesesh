import { expect, test } from "./test-fixtures.js";

const siteUrl = "https://codesesh.xingkaixin.me";

const locales = [
  { route: "/", language: "en", canonical: `${siteUrl}/` },
  { route: "/zh/", language: "zh-CN", canonical: `${siteUrl}/zh/` },
  { route: "/ja/", language: "ja", canonical: `${siteUrl}/ja/` },
] as const;

for (const locale of locales) {
  test(`${locale.language} route serves its language and links the other locales`, async ({
    page,
  }) => {
    await page.goto(locale.route);

    await expect(page.locator("html")).toHaveAttribute("lang", locale.language);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", locale.canonical);
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
      "href",
      `${siteUrl}/`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]')).toHaveAttribute(
      "href",
      `${siteUrl}/zh/`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="ja"]')).toHaveAttribute(
      "href",
      `${siteUrl}/ja/`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
      "href",
      `${siteUrl}/`,
    );
    await expect(page.locator('header .desktop-languages a[aria-current="page"]')).toHaveAttribute(
      "href",
      locale.route,
    );
  });
}

test("copies the install command with the clipboard API", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          Reflect.set(window, "__copiedCommand", value);
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto("/");

  const copy = page.locator(".hero [data-copy-command]");
  await copy.click();

  await expect(copy).toContainText("Copied");
  await expect
    .poll(() =>
      page.evaluate(() => ("__copiedCommand" in window ? window.__copiedCommand : undefined)),
    )
    .toBe("npx codesesh");

  await page.locator("#cta-install-panel-npm [data-copy-command]").click();
  await expect
    .poll(() =>
      page.evaluate(() => ("__copiedCommand" in window ? window.__copiedCommand : undefined)),
    )
    .toBe("npx codesesh@latest");
});
