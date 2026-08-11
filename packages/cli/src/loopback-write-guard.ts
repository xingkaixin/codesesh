import type { MiddlewareHandler } from "hono";
import { appLogger } from "./logging.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

export type LoopbackWriteRejection = "content-type" | "fetch-site" | "origin";

export type LoopbackWriteDecision =
  | { allowed: true }
  | { allowed: false; reason: LoopbackWriteRejection; status: 403 | 415 };

interface LoopbackWriteRequest {
  method: string;
  contentType?: string;
  fetchSite?: string;
  origin?: string;
  requestOrigin: string;
}

function mediaType(contentType: string | undefined): string | null {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function isSameOrigin(origin: string, requestOrigin: string): boolean {
  try {
    return new URL(origin).origin === requestOrigin;
  } catch {
    return false;
  }
}

export function evaluateLoopbackWriteRequest(request: LoopbackWriteRequest): LoopbackWriteDecision {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { allowed: true };

  if (JSON_BODY_METHODS.has(method) && mediaType(request.contentType) !== "application/json") {
    return { allowed: false, reason: "content-type", status: 415 };
  }
  if (request.fetchSite && !ALLOWED_FETCH_SITES.has(request.fetchSite)) {
    return { allowed: false, reason: "fetch-site", status: 403 };
  }
  if (request.origin && !isSameOrigin(request.origin, request.requestOrigin)) {
    return { allowed: false, reason: "origin", status: 403 };
  }
  return { allowed: true };
}

export function loopbackWriteGuard(): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const decision = evaluateLoopbackWriteRequest({
      method: c.req.method,
      contentType: c.req.header("Content-Type"),
      fetchSite: c.req.header("Sec-Fetch-Site"),
      origin: c.req.header("Origin"),
      requestOrigin: url.origin,
    });
    if (!decision.allowed) {
      appLogger.warn("http.loopback_write.rejected", {
        method: c.req.method,
        path: url.pathname,
        reason: decision.reason,
      });
      const error =
        decision.reason === "content-type"
          ? "Write requests require application/json"
          : "Cross-origin write request rejected";
      return c.json({ error }, decision.status);
    }
    await next();
  };
}
