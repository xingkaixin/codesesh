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

export interface ApiRouteOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
}

function createSseResponse(eventSource: ScanEventSource, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cancelStream = () => {};

  return new Response(
    new ReadableStream({
      start(controller) {
        let isClosed = false;
        const write = (event: string, data: unknown) => {
          if (isClosed) return;
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        write("connected", { timestamp: Date.now() });
        write("scan-status", eventSource.getScanStatus());

        const unsubscribeSessions = eventSource.subscribe((event) => {
          write(event.type, event);
        });
        const unsubscribeScanStatus = eventSource.subscribeScanStatus((event) => {
          write(event.type, event);
        });

        const heartbeat = setInterval(() => {
          if (!isClosed) controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15000);

        const cleanup = () => {
          if (isClosed) return false;
          isClosed = true;
          clearInterval(heartbeat);
          unsubscribeSessions();
          unsubscribeScanStatus();
          signal.removeEventListener("abort", abortStream);
          return true;
        };
        const abortStream = () => {
          if (cleanup()) controller.close();
        };
        cancelStream = () => {
          cleanup();
        };

        if (signal.aborted) abortStream();
        else signal.addEventListener("abort", abortStream, { once: true });
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
  api.get("/sessions", (c) => handleGetSessions(c, scanSource, listDefaults));
  api.get("/search", (c) => handleSearchSessions(c, scanSource, listDefaults));
  api.get("/file-activity", (c) => handleGetFileActivity(c, listDefaults));
  api.get("/sessions/:agent/:id", (c) => handleGetSessionData(c, scanSource));
  api.get("/dashboard", (c) => handleGetDashboard(c, scanSource, listDefaults));
  api.get("/bookmarks", (c) => handleGetBookmarks(c));
  api.put("/bookmarks", (c) => handlePutBookmark(c));
  api.post("/bookmarks/import", (c) => handleImportBookmarks(c));
  api.delete("/bookmarks/:agent/:id", (c) => handleDeleteBookmark(c));
  api.put("/session-aliases/:agent/:id", (c) => handlePutSessionAlias(c));
  api.delete("/session-aliases/:agent/:id", (c) => handleDeleteSessionAlias(c));
  api.post("/logs", (c) => handlePostClientLog(c));
  if (eventSource) {
    api.get("/events", (c) => createSseResponse(eventSource, c.req.raw.signal));
  }

  return api;
}
