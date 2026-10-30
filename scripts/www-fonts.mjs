// Subsets the www site's web fonts to what its built pages render, then commits
// the result as apps/www/src/fonts. Run manually (needs uv and Playwright Chromium):
//   node scripts/www-fonts.mjs
// Rerun after changing site copy, font weights or styles, font-variant or
// font-feature-settings, text-transform or hyphens, or the pinned upstream fonts.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { getPnpmInvocation } from "./lib/pnpm-process.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "apps/www/dist");
const pnpm = getPnpmInvocation();
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", shell: pnpm.shell });

run(pnpm.executable, ["--filter", "@codesesh/contract", "build"]);
run(pnpm.executable, ["--filter", "@codesesh/www", "build"]);

async function htmlPages(dir, prefix = "/") {
  const pages = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      pages.push(...(await htmlPages(join(dir, entry.name), `${prefix}${entry.name}/`)));
    else if (entry.name === "index.html") pages.push(prefix);
    else if (entry.name === "404.html") pages.push(`${prefix}404.html`);
  }
  return pages;
}

const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = join(dist, path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Runs in the page. Records every character each first-choice font family would
// draw, including hidden text, pseudo-element content, list markers and the
// data-* labels scripts swap in, together with the weights and OpenType features
// the computed styles request.
function collectUsage() {
  const families = {};
  const laid = {};
  const numeric = {
    "lining-nums": "lnum",
    "oldstyle-nums": "onum",
    "proportional-nums": "pnum",
    "tabular-nums": "tnum",
    "diagonal-fractions": "frac",
    "stacked-fractions": "afrc",
    ordinal: "ordn",
    "slashed-zero": "zero",
  };
  const caps = {
    "small-caps": ["smcp"],
    "all-small-caps": ["smcp", "c2sc"],
    "petite-caps": ["pcap"],
    "all-petite-caps": ["pcap", "c2pc"],
    unicase: ["unic"],
    "titling-caps": ["titl"],
  };
  const ligatures = { "discretionary-ligatures": "dlig", "historical-ligatures": "hlig" };
  const markers = { disc: "• ", circle: "◦ ", square: "▪ ", none: "" };
  const unsupported = (style, property, value) => {
    throw new Error(
      `${property}: ${value} is not handled; extend scripts/www-fonts.mjs (${style.fontFamily})`,
    );
  };
  const features = (style) => {
    const tags = [];
    for (const value of style.fontVariantNumeric.split(" "))
      if (numeric[value]) tags.push(numeric[value]);
    tags.push(...(caps[style.fontVariantCaps] ?? []));
    for (const value of style.fontVariantLigatures.split(" "))
      if (ligatures[value]) tags.push(ligatures[value]);
    if (style.fontVariantPosition === "sub") tags.push("subs");
    if (style.fontVariantPosition === "super") tags.push("sups");
    for (const [, tag, value] of style.fontFeatureSettings.matchAll(/"(\w{4})"\s*(\w+)?/g)) {
      if (value !== "0" && value !== "off") tags.push(tag);
    }
    if (style.fontVariantEastAsian !== "normal")
      unsupported(style, "font-variant-east-asian", style.fontVariantEastAsian);
    if (style.fontVariantAlternates !== "normal")
      unsupported(style, "font-variant-alternates", style.fontVariantAlternates);
    if (style.fontStretch !== "100%") unsupported(style, "font-stretch", style.fontStretch);
    return tags;
  };
  const weights = (style) => {
    const values = [Number(style.fontWeight)];
    for (const [, axis, value] of style.fontVariationSettings.matchAll(/"(\w{4})"\s*([\d.]+)/g)) {
      if (axis !== "wght")
        unsupported(style, "font-variation-settings", style.fontVariationSettings);
      values.push(Number(value));
    }
    return values;
  };
  const transform = (text, style) => {
    if (style.textTransform === "uppercase") return text.toUpperCase();
    if (style.textTransform === "lowercase") return text.toLowerCase();
    if (style.textTransform === "capitalize") return text + text.toUpperCase();
    return text;
  };
  const record = (style, text, isLaid, lang) => {
    const family = style.fontFamily
      .split(",")[0]
      .trim()
      .replace(/^["']|["']$/g, "");
    let chars = transform(text, style).replace(/[\n\r\t]/g, "");
    if (style.textOverflow === "ellipsis") chars += "…";
    if (style.hyphens === "auto") chars += "‐-";
    if (!chars) return;
    const usage = (families[family] ??= {
      chars: new Set(),
      weights: new Set(),
      features: new Set(),
      langs: new Set(),
    });
    for (const char of chars) usage.chars.add(char);
    for (const weight of weights(style)) {
      usage.weights.add(weight);
      if (isLaid) (laid[family] ??= new Set()).add(weight);
    }
    for (const tag of features(style)) usage.features.add(tag);
    if (lang) usage.langs.add(lang);
  };
  const langOf = (element) => element.closest("[lang]")?.getAttribute("lang") ?? "";
  const isLaid = (element) => element.getClientRects().length > 0;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) continue;
    // Collapsible whitespace draws nothing; trim() also strips U+00A0, which does draw.
    if (!node.data.trim() && !node.data.includes("\u00a0")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    record(
      getComputedStyle(element),
      node.data,
      range.getClientRects().length > 0,
      langOf(element),
    );
  }
  for (const element of document.body.querySelectorAll("*")) {
    const lang = langOf(element);
    const elementLaid = isLaid(element);
    const style = getComputedStyle(element);
    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(element, pseudo);
      if (["none", "normal"].includes(pseudoStyle.content)) continue;
      let text = "";
      for (const match of pseudoStyle.content.matchAll(
        /"((?:[^"\\]|\\.)*)"|counters?\([^)]*\)|attr\(([^)]*)\)|(open|close)-quote/g,
      )) {
        if (match[1] !== undefined) text += match[1].replace(/\\(.)/g, "$1");
        else if (match[2] !== undefined) text += element.getAttribute(match[2].trim()) ?? "";
        else if (match[3])
          text += pseudoStyle.quotes === "auto" ? "“”‘’" : pseudoStyle.quotes.replace(/[" ]/g, "");
        else text += "0123456789•◦▪";
      }
      record(pseudoStyle, text, elementLaid, lang);
    }
    if (style.display === "list-item") {
      const type = style.listStyleType;
      const text = type.startsWith('"') ? type.slice(1, -1) : (markers[type] ?? "0123456789. ");
      record(getComputedStyle(element, "::marker"), text, elementLaid, lang);
    }
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith("data-")) record(style, attribute.value, false, lang);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      record(style, element.placeholder + element.value, elementLaid, lang);
    }
  }
  const plain = (usage) => ({
    chars: [...usage.chars].join(""),
    weights: [...usage.weights],
    features: [...usage.features],
    langs: [...usage.langs],
  });
  return {
    families: Object.fromEntries(
      Object.entries(families).map(([family, usage]) => [family, plain(usage)]),
    ),
    laid: Object.fromEntries(Object.entries(laid).map(([family, set]) => [family, [...set]])),
  };
}

const usage = { families: {}, pages: {} };
const browser = await chromium.launch();
for (const page of await htmlPages(dist)) {
  usage.pages[page] = {};
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    await context.route(
      (url) => url.origin !== origin,
      (route) => route.abort(),
    );
    const tab = await context.newPage();
    await tab.goto(origin + page, { waitUntil: "load" });
    const result = await tab.evaluate(collectUsage);
    await context.close();
    for (const [family, found] of Object.entries(result.families)) {
      const merged = (usage.families[family] ??= {
        chars: "",
        weights: [],
        features: [],
        langs: [],
      });
      merged.chars = [...new Set(merged.chars + found.chars)].join("");
      for (const key of ["weights", "features", "langs"])
        merged[key] = [...new Set([...merged[key], ...found[key]])];
    }
    for (const [family, weights] of Object.entries(result.laid)) {
      usage.pages[page][family] = [...new Set([...(usage.pages[page][family] ?? []), ...weights])];
    }
  }
}
await browser.close();
server.close();

const usageFile = join(await mkdtemp(join(tmpdir(), "www-fonts-")), "usage.json");
await writeFile(usageFile, JSON.stringify(usage));
run("uv", ["run", "--script", "scripts/www-fonts.py", usageFile]);
run(pnpm.executable, ["exec", "oxfmt", "--write", "apps/www/src/fonts"]);
