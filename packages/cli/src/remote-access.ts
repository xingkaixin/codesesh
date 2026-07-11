import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

export const REMOTE_ACCESS_QUERY_PARAM = "access_token";

export function createRemoteAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function bearerToken(c: Context): string | undefined {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function requestToken(c: Context): string | undefined {
  const bearer = bearerToken(c);
  if (bearer) return bearer;
  if (c.req.method !== "GET") return undefined;
  return c.req.query(REMOTE_ACCESS_QUERY_PARAM);
}

export function remoteAccessAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (!tokenMatches(requestToken(c), expectedToken)) {
      return c.json({ error: "Remote access authentication required" }, 401);
    }
    await next();
  };
}
