import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  handleGetAgents,
  handleGetConfig,
  handleGetProjects,
  handleGetScanStatus,
} from "./catalog-handlers.js";
import { handleGetDashboard } from "./dashboard-handler.js";
import { handleGetFileActivity, handleSearchSessions } from "./search-handlers.js";
import { handleGetSessions, handleGetSessionData } from "./session-handlers.js";
import { handlePostClientLog } from "./client-log-handler.js";
import type { ScanResultSource } from "./scan-sources.js";
import type { SessionListDefaults } from "./query-params.js";
import {
  handleDeleteBookmark,
  handleDeleteSessionAlias,
  handleGetBookmarks,
  handleImportBookmarks,
  handlePutBookmark,
  handlePutSessionAlias,
} from "./bookmark-handlers.js";
import type { ScanEventSource } from "../scan-source.js";
import type { ProjectIdentityResolver } from "../project-identity-resolver.js";
import { appLogger } from "../logging.js";
import type { SessionDetailLoader } from "../session-detail-loader.js";
import { SseEventBuffer } from "./sse-event-buffer.js";

export const MAX_ACTIVE_SSE_CONNECTIONS = 32;

type SseConnectionCloseReason =
  | "client_cancelled"
  | "client_disconnected"
  | "client_too_slow"
  | "server_shutdown"
  | "setup_failed";

export interface ApiRouteOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
  shutdownSignal?: AbortSignal;
  projectIdentityResolver?: ProjectIdentityResolver;
  loadSessionDetail?: SessionDetailLoader;
}

interface SseConnectionBudget {
  acquire(): (() => void) | null;
  activeCount(): number;
}

function createSseConnectionBudget(maxConnections: number): SseConnectionBudget {
  let activeConnections = 0;
  return {
    acquire() {
      if (activeConnections >= maxConnections) return null;
      activeConnections += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeConnections -= 1;
      };
    },
    activeCount() {
      return activeConnections;
    },
  };
}

function createSseResponse(
  eventSource: ScanEventSource,
  requestSignal: AbortSignal,
  shutdownSignal: AbortSignal | undefined,
  closeConnection: (reason: SseConnectionCloseReason) => void,
): Response {
  let cancelStream = () => {};
  let drainStream = () => {};

  return new Response(
    new ReadableStream({
      start(controller) {
        let isClosed = false;
        let unsubscribeSessions = () => {};
        let unsubscribeScanStatus = () => {};
        let disconnectStream = () => {};
        let shutdownStream = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let buffer: SseEventBuffer | undefined;

        const cleanup = (reason: SseConnectionCloseReason) => {
          if (isClosed) return false;
          isClosed = true;
          buffer?.close();
          if (heartbeat) clearInterval(heartbeat);
          unsubscribeSessions();
          unsubscribeScanStatus();
          requestSignal.removeEventListener("abort", disconnectStream);
          shutdownSignal?.removeEventListener("abort", shutdownStream);
          closeConnection(reason);
          return true;
        };
        disconnectStream = () => {
          if (cleanup("client_disconnected")) controller.close();
        };
        shutdownStream = () => {
          if (cleanup("server_shutdown")) controller.close();
        };
        buffer = new SseEventBuffer(controller, () => {
          if (cleanup("client_too_slow")) controller.error(new Error("SSE client fell behind"));
        });
        drainStream = () => buffer.drain();

        try {
          buffer.enqueue("connected", { timestamp: Date.now() });
          buffer.enqueueScanStatus(eventSource.getScanStatus());

          unsubscribeSessions = eventSource.subscribe((event) => {
            buffer?.enqueue(event.type, event);
          });
          unsubscribeScanStatus = eventSource.subscribeScanStatus((event) => {
            buffer?.enqueueScanStatus(event);
          });

          heartbeat = setInterval(() => buffer?.enqueueHeartbeat(), 15000);
          cancelStream = () => {
            cleanup("client_cancelled");
          };

          if (shutdownSignal?.aborted) shutdownStream();
          else if (requestSignal.aborted) disconnectStream();
          else {
            requestSignal.addEventListener("abort", disconnectStream, { once: true });
            shutdownSignal?.addEventListener("abort", shutdownStream, { once: true });
          }
        } catch (error) {
          cleanup("setup_failed");
          throw error;
        }
      },
      pull() {
        drainStream();
      },
      cancel() {
        cancelStream();
      },
    }),
    {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    },
  );
}

export function createApiRoutes(
  scanSource: ScanResultSource,
  eventSource?: ScanEventSource,
  options: ApiRouteOptions = {},
): Hono {
  const api = new Hono();
  const sseConnections = createSseConnectionBudget(MAX_ACTIVE_SSE_CONNECTIONS);
  const listDefaults: SessionListDefaults = {
    from: options.defaultSessionFrom,
    to: options.defaultSessionTo,
    days: options.defaultSessionDays,
  };

  api.get("/config", (c) => handleGetConfig(c, listDefaults));
  if (eventSource) {
    api.get("/status", (c) => handleGetScanStatus(c, eventSource));
  }
  api.get("/agents", (c) => handleGetAgents(c, scanSource, listDefaults));
  api.get("/projects", (c) => handleGetProjects(c, scanSource, listDefaults));
  api.get("/sessions", (c) =>
    handleGetSessions(c, scanSource, listDefaults, options.projectIdentityResolver),
  );
  api.get("/search", (c) =>
    handleSearchSessions(c, scanSource, listDefaults, options.projectIdentityResolver),
  );
  api.get("/file-activity", (c) =>
    handleGetFileActivity(c, listDefaults, options.projectIdentityResolver),
  );
  api.get("/sessions/:agent/:id", (c) =>
    handleGetSessionData(c, scanSource, options.loadSessionDetail),
  );
  api.get("/dashboard", (c) => handleGetDashboard(c, scanSource, listDefaults));
  api.get("/bookmarks", (c) => handleGetBookmarks(c, scanSource));
  api.put("/bookmarks", (c) => handlePutBookmark(c));
  api.post("/bookmarks/import", (c) => handleImportBookmarks(c, scanSource));
  api.delete("/bookmarks/:agent/:id", (c) => handleDeleteBookmark(c));
  api.put("/session-aliases/:agent/:id", (c) => handlePutSessionAlias(c));
  api.delete("/session-aliases/:agent/:id", (c) => handleDeleteSessionAlias(c));
  api.post("/logs", (c) => handlePostClientLog(c));
  if (eventSource) {
    api.get("/events", (c) => {
      const releaseConnection = sseConnections.acquire();
      if (!releaseConnection) {
        appLogger.warn("api.sse.connection_limit_reached", {
          active_connections: sseConnections.activeCount(),
          connection_limit: MAX_ACTIVE_SSE_CONNECTIONS,
        });
        c.header("Retry-After", "1");
        return c.json({ error: "Too many active event streams" }, 429);
      }
      const connectionId = randomUUID();
      const connectedAt = performance.now();
      let isClosed = false;
      appLogger.info("api.sse.connection.opened", {
        connection_id: connectionId,
        active_connections: sseConnections.activeCount(),
        connection_limit: MAX_ACTIVE_SSE_CONNECTIONS,
      });
      const closeConnection = (reason: SseConnectionCloseReason) => {
        if (isClosed) return;
        isClosed = true;
        releaseConnection();
        appLogger.info("api.sse.connection.closed", {
          connection_id: connectionId,
          close_reason: reason,
          duration_ms: Math.max(0, Math.round(performance.now() - connectedAt)),
          active_connections: sseConnections.activeCount(),
        });
      };
      try {
        return createSseResponse(
          eventSource,
          c.req.raw.signal,
          options.shutdownSignal,
          closeConnection,
        );
      } catch (error) {
        closeConnection("setup_failed");
        throw error;
      }
    });
  }

  return api;
}
