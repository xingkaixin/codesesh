import { Hono } from "hono";
import {
  handleGetAgents,
  handleGetConfig,
  handleGetDashboard,
  handleSearchSessions,
  handleGetSessions,
  handleGetSessionData,
  type ScanResultSource,
  type SessionListDefaults,
} from "./handlers.js";
import type { LiveScanStore } from "../live-scan.js";

export interface ApiRouteOptions {
  defaultSessionFrom?: number;
  defaultSessionTo?: number;
  defaultSessionDays?: number;
}

function createSseResponse(store: LiveScanStore, signal: AbortSignal): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        const write = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        write("connected", { timestamp: Date.now() });

        const unsubscribe = store.subscribe((event) => {
          write(event.type, event);
        });

        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15000);

        const close = () => {
          clearInterval(heartbeat);
          unsubscribe();
          controller.close();
        };

        signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        return;
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
  store?: LiveScanStore,
  options: ApiRouteOptions = {},
): Hono {
  const api = new Hono();
  const listDefaults: SessionListDefaults = {
    from: options.defaultSessionFrom,
    to: options.defaultSessionTo,
    days: options.defaultSessionDays,
  };

  api.get("/config", (c) => handleGetConfig(c, listDefaults));
  api.get("/agents", (c) => handleGetAgents(c, scanSource, listDefaults));
  api.get("/sessions", (c) => handleGetSessions(c, scanSource, listDefaults));
  api.get("/search", (c) => handleSearchSessions(c, scanSource, listDefaults));
  api.get("/sessions/:agent/:id", (c) => handleGetSessionData(c, scanSource));
  api.get("/dashboard", (c) => handleGetDashboard(c, scanSource, listDefaults));
  if (store) {
    api.get("/events", (c) => createSseResponse(store, c.req.raw.signal));
  }

  return api;
}
