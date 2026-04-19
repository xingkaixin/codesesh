import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRoutes } from "./api/routes.js";
import { LiveScanStore } from "./live-scan.js";

function findWebDistPath(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Priority 1: Packaged web dist (copied during build)
  const packagedPath = resolve(__dirname, "web");
  if (existsSync(packagedPath)) {
    return packagedPath;
  }

  // Priority 2: Development path (monorepo)
  const devPath = resolve(__dirname, "../../../apps/web/dist");
  if (existsSync(devPath)) {
    return devPath;
  }

  return null;
}

export async function createServer(
  port: number,
  store: LiveScanStore,
): Promise<{ url: string; shutdown: () => void }> {
  const app = new Hono();

  app.use("*", logger());

  // API routes
  app.route("/api", createApiRoutes(store, store));

  // Serve static files from web dist (if available)
  const webDistPath = findWebDistPath();

  if (webDistPath) {
    app.use("/*", serveStatic({ root: webDistPath }));
    app.get("/*", serveStatic({ root: webDistPath, path: "index.html" }));
  }

  const server = serve({ fetch: app.fetch, port });

  const url = `http://localhost:${port}`;

  return {
    url,
    shutdown: () => {
      server.close();
      void store.shutdown();
    },
  };
}
