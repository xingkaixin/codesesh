import { latestReleaseDate, sitemapEntries } from "../data/changelog";
import { landingUpdated, localeConfig, siteUrl } from "../data/landing";
import { guideSitemapEntries } from "../data/guides";

export const prerender = true;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function absoluteUrl(route: string): string {
  return new URL(route, siteUrl).toString();
}

export function GET(): Response {
  const homeUpdated = latestReleaseDate > landingUpdated ? latestReleaseDate : landingUpdated;
  const entries = [
    ...sitemapEntries.map((entry) => ({
      ...entry,
      lastmod: entry.route === localeConfig[entry.locale].route ? homeUpdated : latestReleaseDate,
    })),
    ...guideSitemapEntries,
  ];
  const urls = entries
    .map((entry) => {
      const alternates = Object.entries(entry.alternates)
        .map(
          ([language, route]) =>
            `    <xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(absoluteUrl(route))}" />`,
        )
        .join("\n");
      const defaultRoute = entry.alternates.en ?? entry.route;

      return [
        "  <url>",
        `    <loc>${escapeXml(absoluteUrl(entry.route))}</loc>`,
        alternates,
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(defaultRoute))}" />`,
        `    <lastmod>${entry.lastmod}</lastmod>`,
        "    <changefreq>weekly</changefreq>",
        `    <priority>${entry.priority}</priority>`,
        "  </url>",
      ].join("\n");
    })
    .join("\n");

  return new Response(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      urls,
      "</urlset>",
      "",
    ].join("\n"),
    {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
      },
    },
  );
}
