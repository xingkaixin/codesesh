import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const site = new URL("../apps/www/", import.meta.url);
const output = new URL(".cloudflare/output/v0/", site);
const worker = new URL("workers/default/", output);

// Prebuilt output avoids cf's automatic setup installing Wrangler for a static site.
await rm(output, { recursive: true, force: true });
await mkdir(worker, { recursive: true });
await cp(new URL("dist/", site), new URL("assets/", worker), { recursive: true });
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
