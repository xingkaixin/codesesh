import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Read version from package.json
const pkg = await import("./package.json", { with: { type: "json" } });

const PRECOMPRESS_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);

function splitI18nCatalogs(): Plugin {
  let cachedCatalogs: Record<"zh-CN" | "ja", Record<string, string>> | null = null;
  const loadCatalogs = async () => {
    if (cachedCatalogs) return cachedCatalogs;
    const mod = (await import("./src/i18n/messages.ts")) as {
      messages: Record<string, readonly [string, string]>;
    };
    const zh: Record<string, string> = {};
    const ja: Record<string, string> = {};
    for (const [key, [zhText, jaText]] of Object.entries(mod.messages)) {
      zh[key] = zhText;
      ja[key] = jaText;
    }
    cachedCatalogs = { "zh-CN": zh, ja };
    return cachedCatalogs;
  };
  return {
    name: "codesesh-split-i18n-catalogs",
    apply: "build",
    async load(id) {
      if (id.endsWith("/src/i18n/sync-catalog.ts")) {
        return "export const syncMessages = null;";
      }
      if (id.endsWith("/src/i18n/catalog-zh.ts")) {
        const catalogs = await loadCatalogs();
        return `export default ${JSON.stringify(catalogs["zh-CN"])};`;
      }
      if (id.endsWith("/src/i18n/catalog-ja.ts")) {
        const catalogs = await loadCatalogs();
        return `export default ${JSON.stringify(catalogs.ja)};`;
      }
      return null;
    },
  };
}

function precompressAssets(): Plugin {
  return {
    name: "codesesh-precompress-assets",
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(import.meta.dirname, "dist");
      const outDir = path.join(distDir, "precompressed");
      fs.rmSync(outDir, { recursive: true, force: true });
      if (!fs.existsSync(distDir)) return;
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "precompressed") continue;
            walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!PRECOMPRESS_EXTENSIONS.has(ext)) continue;
          const raw = fs.readFileSync(full);
          if (raw.length < 256) continue;
          const rel = path.relative(distDir, full);
          const targetBase = path.join(outDir, rel);
          fs.mkdirSync(path.dirname(targetBase), { recursive: true });
          const br = zlib.brotliCompressSync(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          });
          if (br.length < raw.length) {
            fs.writeFileSync(`${targetBase}.br`, br);
          }
          const gz = zlib.gzipSync(raw, { level: 9 });
          if (gz.length < raw.length) {
            fs.writeFileSync(`${targetBase}.gz`, gz);
          }
        }
      };
      walk(distDir);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), splitI18nCatalogs(), precompressAssets()],
  build: {
    // No manual chunk map: naming chunks does not make a static dependency
    // async, and pinning vendors into shared chunks pulls them into the entry
    // as soon as one member is reachable synchronously. The dynamic imports in
    // AppRouteContent define the boundaries instead.
    rolldownOptions: {
      output: {
        codeSplitting: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.default.version),
  },
});
