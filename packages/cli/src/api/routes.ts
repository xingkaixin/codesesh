import { Hono } from "hono";
import type { ScanResult } from "@codesesh/core";
import { handleGetAgents, handleGetSessions, handleGetSessionData } from "./handlers.js";

export function createApiRoutes(scanResult: ScanResult): Hono {
  const api = new Hono();

  api.get("/agents", (c) => handleGetAgents(c, scanResult));
  api.get("/sessions", (c) => handleGetSessions(c, scanResult));
  api.get("/sessions/:agent/:id", (c) => handleGetSessionData(c, scanResult));

  return api;
}
