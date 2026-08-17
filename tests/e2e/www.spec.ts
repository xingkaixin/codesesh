import { expect, test } from "./test-fixtures.js";
import { AGENT_CATALOG } from "@codesesh/core/contract";

const siteUrl = "https://codesesh.xingkaixin.me";
const supportedAgents = AGENT_CATALOG.map(({ displayName }) => displayName);

const locales = [
  { route: "/", language: "en", canonical: `${siteUrl}/` },
  { route: "/zh/", language: "zh-CN", canonical: `${siteUrl}/zh/` },
] as const;

interface JsonLdNode {
  "@id"?: string;
  "@type"?: string;
  downloadUrl?: string;
  inLanguage?: string;
  isAccessibleForFree?: boolean;
  license?: string;
  url?: string;
  mainEntity?: Array<{
    name?: string;
    acceptedAnswer?: { text?: string };
  }>;
}

test("keeps production analytics out of development", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('script[src*="cloudflareinsights.com"]')).toHaveCount(0);
});

for (const locale of locales) {
  test(`${locale.language} metadata and structured content match the page`, async ({ page }) => {
    await page.goto(locale.route);

    await expect(page.locator("html")).toHaveAttribute("lang", locale.language);
    expect(await page.evaluate(() => document.querySelectorAll("h1").length)).toBe(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", locale.canonical);
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
      "href",
      `${siteUrl}/`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]')).toHaveAttribute(
      "href",
      `${siteUrl}/zh/`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
      "href",
      `${siteUrl}/`,
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
    );
    await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute(
      "content",
      await page.title(),
    );

    const faqItems = page.locator("#faq details");
    const visibleFaq = [];
    for (let index = 0; index < (await faqItems.count()); index += 1) {
      const item = faqItems.nth(index);
      await item.locator("summary").click();
      await expect(item.locator("p")).toBeVisible();
      visibleFaq.push({
        name: (await item.locator("h3").innerText()).trim(),
        text: (await item.locator("p").innerText()).trim(),
      });
    }

    const jsonLdSource = await page.locator('script[type="application/ld+json"]').textContent();
    expect(jsonLdSource).not.toBeNull();
    const jsonLd = JSON.parse(jsonLdSource ?? "") as { "@graph"?: JsonLdNode[] };
    expect(jsonLd["@graph"]).toBeInstanceOf(Array);
    const software = jsonLd["@graph"]?.find((node) => node["@type"] === "SoftwareApplication");
    expect(software).toMatchObject({
      downloadUrl: "https://www.npmjs.com/package/codesesh",
      isAccessibleForFree: true,
      license: "https://opensource.org/license/mit",
    });

    const webPage = jsonLd["@graph"]?.find((node) => node["@type"] === "WebPage");
    expect(webPage).toMatchObject({
      inLanguage: locale.language,
      url: locale.canonical,
    });

    const faqPage = jsonLd["@graph"]?.find((node) => node["@type"] === "FAQPage");
    expect(faqPage).toBeDefined();
    expect(
      faqPage?.mainEntity?.map((question) => ({
        name: question.name,
        text: question.acceptedAnswer?.text,
      })),
    ).toEqual(visibleFaq);

    const agentNames = await page.locator("#agents ul > li").allInnerTexts();
    expect(agentNames.map((name) => name.trim())).toEqual(supportedAgents);
    await expect(page.getByText("Antigravity", { exact: true })).toHaveCount(0);
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

  const copy = page.locator("[data-copy-command]").first();
  await copy.click();

  await expect(copy).toContainText("Copied");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__copiedCommand")))
    .toBe("npx codesesh");
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

  const group = page.locator("[data-copy-group]").first();
  const copy = group.locator("[data-copy-command]");
  await copy.click();

  await expect(copy).toContainText("Copy failed");
  await expect(group.locator("[data-copy-status]")).toHaveText(
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

  const copy = page.locator("[data-copy-command]").first();
  await copy.click();

  await expect(copy).toContainText("Copied");
});

test("explores each interactive product preview", async ({ page }) => {
  await page.goto("/");

  const overview = page.locator('[data-product-demo="overview"]');
  const thirtyDays = overview.locator('[data-demo-range="30d"]');
  await expect(overview.locator('[data-demo-kpi="0"] [data-demo-kpi-value]')).toHaveText("212");
  await thirtyDays.click();
  await expect(thirtyDays).toHaveAttribute("aria-pressed", "true");
  await expect(overview.locator('[data-demo-kpi="0"] [data-demo-kpi-value]')).toHaveText("863");
  await expect(overview.locator("[data-demo-range-chip]")).toContainText("Last 30d");

  const project = page.locator('[data-product-demo="projects"]');
  const subsession = project.locator("details[data-demo-subsession]").first();
  await subsession.locator("summary").click();
  await expect(subsession).toHaveAttribute("open", "");
  await expect(subsession).toContainText("Generate step validation schema");

  const replay = page.locator('[data-product-demo="replay"]');
  const tool = replay.locator('details[data-demo-tool="edit_file"]');
  await tool.locator("summary").click();
  await expect(tool).toHaveAttribute("open", "");
  await expect(tool).toContainText("buildClauses(filters)");
});

test("keeps the landing page within a 390px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
});

test("removes landing and product preview motion when reduced motion is requested", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.locator(".hero-copy")).toHaveCSS("animation-name", "none");
  await expect(page.locator('[data-product-demo="overview"] .demo-bar-fill').first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
});
