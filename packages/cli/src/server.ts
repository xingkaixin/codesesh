import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanResultSource } from "./api/handlers.js";
import { createApiRoutes, type ApiRouteOptions } from "./api/routes.js";
import { LiveScanStore } from "./live-scan.js";
import { appLogger } from "./logging.js";
import {
  createRemoteAccessToken,
  isLoopbackHostname,
  REMOTE_ACCESS_QUERY_PARAM,
  remoteAccessAuth,
} from "./remote-access.js";

const MAX_API_REQUEST_BYTES = 1024 * 1024;

export interface CreateServerOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
  portFallbackAttempts?: number;
  hostname?: string;
  remoteAccess?: boolean;
  remoteAccessToken?: string;
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

function waitForListening(server: ServerType): Promise<void> {
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

function getListeningPort(server: ServerType, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? (address as AddressInfo).port : fallback;
}

export async function createServer(
  port: number,
  store: ScanResultSource &
    Partial<
      Pick<LiveScanStore, "getScanStatus" | "subscribe" | "subscribeScanStatus" | "shutdown">
    >,
  options: CreateServerOptions = {},
): Promise<{ url: string; shutdown: () => Promise<void> }> {
  const app = new Hono();
  const hostname = options.hostname ?? "127.0.0.1";
  const isLoopback = isLoopbackHostname(hostname);
  const remoteAccessToken = !isLoopback
    ? (options.remoteAccessToken ?? (options.remoteAccess ? createRemoteAccessToken() : null))
    : null;

  if (!isLoopback && !remoteAccessToken) {
    throw new Error(
      `Refusing to expose CodeSesh on ${hostname} without authentication. Add --remote-access to continue.`,
    );
  }

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

  if (remoteAccessToken) {
    app.use("/api/*", remoteAccessAuth(remoteAccessToken));
  }
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_API_REQUEST_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );

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
  let server: ServerType | null = null;
  let actualPort = port;

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidatePort = port + offset;
    server = serve({ fetch: app.fetch, port: candidatePort, hostname });

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

  const baseUrl = isLoopback
    ? `http://localhost:${actualPort}`
    : `http://${hostname}:${actualPort}`;
  const url = remoteAccessToken
    ? `${baseUrl}/?${REMOTE_ACCESS_QUERY_PARAM}=${encodeURIComponent(remoteAccessToken)}`
    : baseUrl;
  appLogger.info("server.listen", {
    port: actualPort,
    requested_port: port,
    hostname,
    remote_access: Boolean(remoteAccessToken),
  });

  if (!isLoopback) {
    appLogger.warn("server.listen.remote_access", { hostname, port: actualPort });
    console.warn(`\n⚠ 远程访问已启用。任何持有启动 URL 的人都可以读取你的 AI 会话记录。\n`);
  }

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
