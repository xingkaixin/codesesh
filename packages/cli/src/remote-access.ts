import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

export const ACCESS_TOKEN_QUERY_PARAM = "access_token";

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
  remoteAccessRequired: boolean;
}

export interface RemoteTransportRequest {
  hostname: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  trustProxy?: boolean;
}

export class RemoteTransportError extends Error {}

function assertTrustedProxyListener(hostname: string, transport: RemoteTransport): void {
  if (transport.kind === "trusted-proxy" && !isLoopbackHostname(hostname)) {
    throw new RemoteTransportError(
      "--trust-proxy requires a loopback --host so clients cannot reach the HTTP backend directly.",
    );
  }
}

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

  if (request.trustProxy) {
    const transport = { kind: "trusted-proxy" } as const;
    assertTrustedProxyListener(request.hostname, transport);
    return transport;
  }
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
  assertTrustedProxyListener(hostname, transport);
  const bindCategory = isLoopbackHostname(hostname) ? "loopback" : "network";
  const directLoopback = bindCategory === "loopback" && transport.kind === "loopback";
  return {
    bindCategory,
    remoteAccessRequired: !directLoopback,
  };
}

export function resolvePublicOrigin(
  value: string | undefined,
  transport: RemoteTransport,
): string | undefined {
  if (transport.kind !== "trusted-proxy") {
    if (value) throw new RemoteTransportError("--public-url requires --trust-proxy.");
    return undefined;
  }
  if (!value) {
    throw new RemoteTransportError(
      "--trust-proxy requires an HTTPS --public-url for browser startup links.",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteTransportError("--public-url must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RemoteTransportError(
      "--public-url must be an HTTPS origin without credentials, path, query, or fragment.",
    );
  }
  return url.origin;
}

const FORWARDED_PROTO_HEADER = "X-Forwarded-Proto";

/**
 * The forwarded scheme validates proxy configuration, not client identity.
 * The enforced loopback listener supplies the network boundary; the access
 * token still authenticates every request that reaches it.
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

export function createAccessToken(): string {
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
  return c.req.query(ACCESS_TOKEN_QUERY_PARAM);
}

export function accessTokenAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    if (!tokenMatches(requestToken(c), expectedToken)) {
      return c.json({ error: "API access token required" }, 401);
    }
    await next();
  };
}
