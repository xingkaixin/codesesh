import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  portFallbackAttempts?: number;
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

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
  );
}

function getListeningPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? (address as AddressInfo).port : fallback;
}

export async function createServer(
  port: number,
  store: ScanResultSource & Partial<Pick<LiveScanStore, "subscribe" | "shutdown">>,
  options: CreateServerOptions = {},
): Promise<{ url: string; shutdown: () => Promise<void> }> {
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

  const attempts = Math.max(1, options.portFallbackAttempts ?? 1);
  let server: Server | null = null;
  let actualPort = port;

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidatePort = port + offset;
    server = serve({ fetch: app.fetch, port: candidatePort });

    try {
      await waitForListening(server);
      actualPort = getListeningPort(server, candidatePort);
      break;
    } catch (error) {
      appLogger.error("server.listen.error", { port: candidatePort, error });
      server.close();

      if (isAddressInUse(error) && offset < attempts - 1) {
        continue;
      }

      if (store.shutdown) {
        await store.shutdown();
      }

      if (isAddressInUse(error) && attempts > 1) {
        throw new Error(
          `端口 ${port}-${port + attempts - 1} 均已被占用，请关闭现有进程或改用 --port 指定其他端口。`,
        );
      }

      throw new Error(getServerStartupErrorMessage(error, candidatePort));
    }
  }

  const url = `http://localhost:${actualPort}`;
  appLogger.info("server.listen", { port: actualPort, requested_port: port, url });

  return {
    url,
    shutdown: async () => {
      appLogger.info("server.shutdown", { port: actualPort });
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      if (store.shutdown) {
        await store.shutdown();
      }
    },
  };
}
