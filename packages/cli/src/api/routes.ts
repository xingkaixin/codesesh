import { Hono } from "hono";
import {
  handleGetAgents,
  handleGetBookmarks,
  handleGetConfig,
  handleGetDashboard,
  handleGetFileActivity,
  handleGetProjects,
  handleGetScanStatus,
  handleDeleteBookmark,
  handleDeleteSessionAlias,
  handleImportBookmarks,
  handlePostClientLog,
  handleSearchSessions,
  handleGetSessions,
  handleGetSessionData,
  handlePutBookmark,
  handlePutSessionAlias,
  type ScanResultSource,
  type SessionListDefaults,
} from "./handlers.js";
import type { ScanEventSource } from "../scan-source.js";
import type { ProjectIdentityResolver } from "../project-identity-resolver.js";
import { SseEventBuffer } from "./sse-event-buffer.js";

export interface ApiRouteOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
  shutdownSignal?: AbortSignal;
  projectIdentityResolver?: ProjectIdentityResolver;
}

function createSseResponse(eventSource: ScanEventSource, signal: AbortSignal): Response {
  let cancelStream = () => {};
  let drainStream = () => {};

  return new Response(
    new ReadableStream({
      start(controller) {
        let isClosed = false;
        let unsubscribeSessions = () => {};
        let unsubscribeScanStatus = () => {};
        let abortStream = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let buffer: SseEventBuffer;

        const cleanup = () => {
          if (isClosed) return false;
          isClosed = true;
          buffer.close();
          if (heartbeat) clearInterval(heartbeat);
          unsubscribeSessions();
          unsubscribeScanStatus();
          signal.removeEventListener("abort", abortStream);
          return true;
        };
        abortStream = () => {
          if (cleanup()) controller.close();
        };
        buffer = new SseEventBuffer(controller, () => {
          if (cleanup()) controller.error(new Error("SSE client fell behind"));
        });
        drainStream = () => buffer.drain();

        buffer.enqueue("connected", { timestamp: Date.now() });
        buffer.enqueueScanStatus(eventSource.getScanStatus());

        unsubscribeSessions = eventSource.subscribe((event) => {
          buffer.enqueue(event.type, event);
        });
        unsubscribeScanStatus = eventSource.subscribeScanStatus((event) => {
          buffer.enqueueScanStatus(event);
        });

        heartbeat = setInterval(() => buffer.enqueueHeartbeat(), 15000);
        cancelStream = () => {
          cleanup();
        };

        if (signal.aborted) abortStream();
        else signal.addEventListener("abort", abortStream, { once: true });
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
  api.get("/sessions/:agent/:id", (c) => handleGetSessionData(c, scanSource));
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
      const signal = options.shutdownSignal
        ? AbortSignal.any([c.req.raw.signal, options.shutdownSignal])
        : c.req.raw.signal;
      return createSseResponse(eventSource, signal);
    });
  }

  return api;
}
