import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

export const REMOTE_ACCESS_QUERY_PARAM = "access_token";

/**
 * How a remote listener's traffic is protected. A token proves who is asking;
 * it says nothing about who else can read the answer, so confidentiality is
 * modelled separately from authentication.
 */
export type RemoteTransport =
  | { kind: "loopback" }
  /** CodeSesh terminates TLS itself. */
  | { kind: "tls"; cert: Buffer; key: Buffer }
  /** A reverse proxy in front of CodeSesh terminates TLS. */
  | { kind: "trusted-proxy" }
  /** The operator accepted plaintext on an untrusted network. */
  | { kind: "plaintext" };

export interface RemoteAccessPolicy {
  bindCategory: "loopback" | "network";
  authenticationRequired: boolean;
}

export interface RemoteTransportRequest {
  hostname: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  trustProxy?: boolean;
}

export class RemoteTransportError extends Error {}

/**
 * Resolves the transport from the CLI flags. Loopback stays plaintext without
 * ceremony: nothing leaves the machine.
 */
export function resolveRemoteTransport(request: RemoteTransportRequest): RemoteTransport {
  const hasCert = Boolean(request.tlsCertPath);
  const hasKey = Boolean(request.tlsKeyPath);
  if (hasCert !== hasKey) {
    throw new RemoteTransportError("TLS requires both --tls-cert and --tls-key.");
  }
  if (hasCert && request.trustProxy) {
    throw new RemoteTransportError(
      "Use either --tls-cert/--tls-key or --trust-proxy, not both: only one of them terminates TLS.",
    );
  }

  if (hasCert) {
    try {
      return {
        kind: "tls",
        cert: readFileSync(request.tlsCertPath!),
        key: readFileSync(request.tlsKeyPath!),
      };
    } catch (error) {
      throw new RemoteTransportError(
        `Unable to read the TLS certificate or key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (request.trustProxy) return { kind: "trusted-proxy" };
  return isLoopbackHostname(request.hostname) ? { kind: "loopback" } : { kind: "plaintext" };
}

/** Whether the transport keeps request and response bodies off the wire in the clear. */
export function isConfidentialTransport(transport: RemoteTransport): boolean {
  return transport.kind !== "plaintext";
}

export function resolveRemoteAccessPolicy(
  hostname: string,
  transport: RemoteTransport,
): RemoteAccessPolicy {
  const bindCategory = isLoopbackHostname(hostname) ? "loopback" : "network";
  return {
    bindCategory,
    authenticationRequired: bindCategory === "network" || transport.kind !== "loopback",
  };
}

const FORWARDED_PROTO_HEADER = "X-Forwarded-Proto";

/**
 * Behind a trusted proxy, a request arriving without the proxy's own
 * `X-Forwarded-Proto: https` did not come through it. Trusting the header is
 * only sound because the deployment is expected to make CodeSesh unreachable
 * except via that proxy — which is what --trust-proxy asserts.
 */
export function requireProxyTls(): MiddlewareHandler {
  return async (c, next) => {
    const proto = c.req.header(FORWARDED_PROTO_HEADER)?.split(",")[0]?.trim().toLowerCase();
    if (proto !== "https") {
      return c.json({ error: "Requests must arrive over TLS through the trusted proxy" }, 403);
    }
    await next();
  };
}

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
