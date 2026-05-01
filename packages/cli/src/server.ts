import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanResultSource } from "./api/handlers.js";
import { createApiRoutes, type ApiRouteOptions } from "./api/routes.js";
import { LiveScanStore } from "./live-scan.js";
import { appLogger } from "./logging.js";

export interface CreateServerOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
}

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

function waitForListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };

    server.once("listening", handleListening);
    server.once("error", handleError);
  });
}

export function getServerStartupErrorMessage(error: unknown, port: number): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  ) {
    return `Port ${port} 已被占用，请关闭现有 CodeSesh 进程或改用 --port 指定其他端口。`;
  }

  return error instanceof Error ? error.message : `启动服务器失败: ${String(error)}`;
}

export async function createServer(
  port: number,
  store: ScanResultSource & Partial<Pick<LiveScanStore, "subscribe" | "shutdown">>,
  options: CreateServerOptions = {},
): Promise<{ url: string; shutdown: () => void }> {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    let thrown: unknown;

    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const url = new URL(c.req.url);
      appLogger.info("http.request", {
        method: c.req.method,
        path: url.pathname,
        query_keys: [...url.searchParams.keys()].toSorted(),
        status: c.res.status,
        duration_ms: Math.round(performance.now() - startedAt),
        error: thrown instanceof Error ? thrown.message : undefined,
      });
    }
  });

  // API routes
  const routeOptions: ApiRouteOptions = {
    defaultSessionFrom: options.defaultSessionFrom,
    defaultSessionTo: options.defaultSessionTo,
    defaultSessionDays: options.defaultSessionDays,
  };
  app.route(
    "/api",
    createApiRoutes(
      store,
      "subscribe" in store ? (store as LiveScanStore) : undefined,
      routeOptions,
    ),
  );

  // Serve static files from web dist (if available)
  const webDistPath = findWebDistPath();

  if (webDistPath) {
    app.use("/*", serveStatic({ root: webDistPath }));
    app.get("/*", serveStatic({ root: webDistPath, path: "index.html" }));
  }

  const server = serve({ fetch: app.fetch, port });

  try {
    await waitForListening(server);
  } catch (error) {
    appLogger.error("server.listen.error", { port, error });
    server.close();
    if (store.shutdown) {
      await store.shutdown();
    }
    throw new Error(getServerStartupErrorMessage(error, port));
  }

  const url = `http://localhost:${port}`;
  appLogger.info("server.listen", { port, url });

  return {
    url,
    shutdown: () => {
      appLogger.info("server.shutdown", { port });
      server.close();
      if (store.shutdown) {
        void store.shutdown();
      }
    },
  };
}
