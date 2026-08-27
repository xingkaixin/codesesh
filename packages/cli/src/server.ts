import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import type { HttpBindings, ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanResultSource } from "./api/handlers.js";
import { createApiRoutes, type ApiRouteOptions } from "./api/routes.js";
import { appLogger } from "./logging.js";
import { ThreadSessionDetailLoader } from "./session-detail-loader.js";
import {
  createProjectIdentityResolver,
  type ProjectIdentityResolver,
} from "./project-identity-resolver.js";
import { validateLoopbackAuthority } from "./loopback-authority.js";
import { loopbackWriteGuard } from "./loopback-write-guard.js";
import {
  ACCESS_TOKEN_QUERY_PARAM,
  accessTokenAuth,
  createAccessToken,
  requireProxyTls,
  resolvePublicOrigin,
  resolveRemoteAccessPolicy,
  resolveRemoteTransport,
  type RemoteTransport,
} from "./remote-access.js";
import type { ScanEventSource } from "./scan-source.js";

const MAX_API_REQUEST_BYTES = 1024 * 1024;
const SERVER_CLOSE_GRACE_MS = 1_000;

export interface CreateServerOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
  portFallbackAttempts?: number;
  hostname?: string;
  remoteAccess?: boolean;
  accessToken?: string;
  publicUrl?: string;
  /** How the listener is protected; defaults to plaintext for a non-loopback host. */
  transport?: RemoteTransport;
  /** Overrides the auto-detected web build directory; used to pin the static root in tests. */
  webDistPath?: string;
  projectIdentityResolver?: ProjectIdentityResolver;
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

async function closeHttpServer(server: ServerType | null, port: number | null): Promise<void> {
  if (!server) return;

  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const gracefulClose = new Promise<void>((resolve) => server.close(() => resolve()));
  const forceClose = new Promise<void>((resolve) => {
    forceCloseTimer = setTimeout(() => {
      appLogger.warn("server.shutdown.force_close", {
        port,
        grace_ms: SERVER_CLOSE_GRACE_MS,
      });
      if ("closeAllConnections" in server) server.closeAllConnections();
      resolve();
    }, SERVER_CLOSE_GRACE_MS);
    forceCloseTimer.unref();
  });

  try {
    await Promise.race([gracefulClose, forceClose]);
  } finally {
    if (forceCloseTimer) clearTimeout(forceCloseTimer);
  }
}

export async function createServer(
  port: number,
  store: ScanResultSource & ScanEventSource & { shutdown(): Promise<void> },
  options: CreateServerOptions = {},
): Promise<{ url: string; listenerUrl: string; shutdown: () => Promise<void> }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const hostname = options.hostname ?? "127.0.0.1";
  const transport: RemoteTransport = options.transport ?? resolveRemoteTransport({ hostname });
  const accessPolicy = resolveRemoteAccessPolicy(hostname, transport);
  const publicOrigin = resolvePublicOrigin(options.publicUrl, transport);
  const accessToken = options.accessToken || createAccessToken();
  const loopbackAuthorityEnabled = !accessPolicy.remoteAccessRequired;
  const shutdownController = new AbortController();
  const projectIdentityResolver =
    options.projectIdentityResolver ?? createProjectIdentityResolver();
  const sessionDetailLoader = new ThreadSessionDetailLoader();
  let actualPort: number | null = null;

  appLogger.info("server.access_policy", {
    bind_category: accessPolicy.bindCategory,
    transport: transport.kind,
    authentication: "token",
    loopback_authority: loopbackAuthorityEnabled ? "enabled" : "disabled",
  });

  if (accessPolicy.remoteAccessRequired && !options.remoteAccess && !options.accessToken) {
    throw new Error(
      `Refusing to expose CodeSesh on ${hostname} without explicit remote access. Add --remote-access to continue.`,
    );
  }

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
      originAgentCluster: false,
      referrerPolicy: "no-referrer",
      strictTransportSecurity: false,
      xContentTypeOptions: "nosniff",
      xDnsPrefetchControl: false,
      xDownloadOptions: false,
      xFrameOptions: "DENY",
      xPermittedCrossDomainPolicies: false,
      xXssProtection: false,
    }),
  );

  if (loopbackAuthorityEnabled) {
    app.use("*", async (c, next) => {
      const decision = validateLoopbackAuthority(c.env.incoming.rawHeaders, hostname, actualPort);
      if (!decision.allowed) {
        appLogger.warn("http.loopback_authority.rejected", {
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          reason: decision.reason,
          authority: decision.authority,
        });
        return c.json({ error: "Loopback request authority rejected" }, 403);
      }
      await next();
    });
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

  // Ordered before authentication: a request that bypassed the proxy must be
  // refused outright, not given a chance to present a token in the clear.
  if (transport.kind === "trusted-proxy") {
    app.use("/api/*", requireProxyTls());
  }
  app.use("/api/*", accessTokenAuth(accessToken));
  app.use("/api/*", loopbackWriteGuard());
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_API_REQUEST_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );
  // Hono's default filter already excludes text/event-stream, so this does not
  // interfere with the /api/events SSE stream.
  app.use("/api/*", compress());

  // API routes
  const routeOptions: ApiRouteOptions = {
    defaultSessionFrom: options.defaultSessionFrom,
    defaultSessionTo: options.defaultSessionTo,
    defaultSessionDays: options.defaultSessionDays,
    shutdownSignal: shutdownController.signal,
    projectIdentityResolver,
    loadSessionDetail: sessionDetailLoader.load,
  };
  app.route("/api", createApiRoutes(store, store, routeOptions));

  // Serve static files from web dist (if available)
  const webDistPath = options.webDistPath ?? findWebDistPath();

  if (webDistPath) {
    app.use("/*", serveStatic({ root: webDistPath }));
    app.get("/*", serveStatic({ root: webDistPath, path: "index.html" }));
  }

  const attempts = Math.max(1, options.portFallbackAttempts ?? 1);
  let server: ServerType | null = null;

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidatePort = port + offset;
    server = serve({
      fetch: app.fetch,
      port: candidatePort,
      hostname,
      ...(transport.kind === "tls"
        ? {
            createServer: createHttpsServer,
            serverOptions: { cert: transport.cert, key: transport.key },
          }
        : {}),
    });

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

      await store.shutdown();

      if (isAddressInUse(error) && attempts > 1) {
        throw new Error(
          `端口 ${port}-${port + attempts - 1} 均已被占用，请关闭现有进程或改用 --port 指定其他端口。`,
        );
      }

      throw new Error(getServerStartupErrorMessage(error, candidatePort));
    }
  }

  // The backend stays HTTP behind a trusted proxy; its separately configured
  // public origin is used only for browser startup.
  const scheme = transport.kind === "tls" ? "https" : "http";
  const listenerUrl =
    accessPolicy.bindCategory === "loopback"
      ? `${scheme}://localhost:${actualPort}`
      : `${scheme}://${hostname}:${actualPort}`;
  const url = `${publicOrigin ?? listenerUrl}/?${ACCESS_TOKEN_QUERY_PARAM}=${encodeURIComponent(accessToken)}`;
  appLogger.info("server.listen", {
    port: actualPort,
    requested_port: port,
    hostname,
    public_origin: publicOrigin,
    remote_access: accessPolicy.remoteAccessRequired,
    transport: transport.kind,
  });

  if (accessPolicy.remoteAccessRequired) {
    appLogger.warn("server.listen.remote_access", {
      hostname,
      port: actualPort,
      transport: transport.kind,
    });
    console.warn(`\n⚠ 远程访问已启用。任何持有启动 URL 的人都可以读取你的 AI 会话记录。\n`);
    if (transport.kind === "plaintext") {
      appLogger.warn("server.listen.plaintext", { hostname, port: actualPort });
      console.warn(
        `⚠ 传输未加密。访问令牌与完整会话内容以明文经过网络，URL 中的令牌还可能写入代理访问日志。\n` +
          `  使用 --tls-cert/--tls-key 直接启用 TLS，或在受信反向代理后使用 --trust-proxy。\n`,
      );
    }
    if (transport.kind === "trusted-proxy") {
      appLogger.warn("server.listen.proxy_logging", { hostname, port: actualPort });
      console.warn(
        `⚠ URL 中的访问令牌会用于 SSE 重连，并可能写入受信反向代理的访问日志。\n` +
          `  请在代理配置中关闭查询参数日志，或对 access_token 参数脱敏。\n`,
      );
    }
  }

  return {
    url,
    listenerUrl,
    shutdown: async () => {
      appLogger.info("server.shutdown", { port: actualPort });
      shutdownController.abort();
      try {
        await sessionDetailLoader.shutdown();
        appLogger.info("server.shutdown.phase", { phase: "http-closing", port: actualPort });
        await closeHttpServer(server, actualPort);
      } finally {
        try {
          await projectIdentityResolver.shutdown();
        } finally {
          appLogger.info("server.shutdown.phase", { phase: "store-closing", port: actualPort });
          await store.shutdown();
        }
      }
      appLogger.info("server.shutdown.phase", { phase: "complete", port: actualPort });
    },
  };
}
