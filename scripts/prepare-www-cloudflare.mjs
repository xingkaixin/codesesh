import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const site = new URL("../apps/www/", import.meta.url);
const output = new URL(".cloudflare/output/v0/", site);
const worker = new URL("workers/default/", output);
const assets = new URL("assets/", worker);

// Prebuilt output avoids cf's automatic setup installing Wrangler for a static site.
await rm(output, { recursive: true, force: true });
await mkdir(worker, { recursive: true });
await cp(new URL("dist/", site), assets, {
  recursive: true,
  filter: (source) => basename(source) !== ".DS_Store",
});
// Workers applies wildcard headers even to 404s, so cache only existing assets.
const fingerprintedAssets = await readdir(new URL("_astro/", assets));
await writeFile(
  new URL("_headers", assets),
  fingerprintedAssets
    .map((name) => `/_astro/${name}\n  Cache-Control: public, max-age=31536000, immutable\n`)
    .join("\n"),
);
await writeFile(
  new URL("config.json", output),
  JSON.stringify({ buildContext: { isPreview: false } }, null, 2),
);
await writeFile(
  new URL("worker.config.json", worker),
  JSON.stringify(
    {
      name: "codesesh",
      compatibilityDate: "2026-10-05",
      workersDev: true,
      domains: ["codesesh.xingkaixin.me"],
      assets: {
        htmlHandling: "force-trailing-slash",
        notFoundHandling: "404-page",
      },
    },
    null,
    2,
  ),
);
