import { isIP } from "node:net";

export type LoopbackAuthorityRejection =
  | "listener-not-ready"
  | "missing-host"
  | "multiple-hosts"
  | "invalid-host"
  | "hostname-not-allowed"
  | "port-mismatch";

export type LoopbackAuthorityDecision =
  | { allowed: true; authority: string }
  | { allowed: false; reason: LoopbackAuthorityRejection; authority?: string };

interface ParsedAuthority {
  hostname: string;
  port: number;
  normalized: string;
}

const LOOPBACK_AUTHORITY_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function canonicalizeHostname(hostname: string): string | null {
  const unwrapped = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const authorityHost = isIP(unwrapped) === 6 ? `[${unwrapped}]` : unwrapped;
  try {
    return new URL(`http://${authorityHost}`).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  } catch {
    return null;
  }
}

function parseAuthority(value: string): ParsedAuthority | null {
  if (!value || value !== value.trim()) return null;
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  const plain = /^([^:[\]]+):(\d{1,5})$/.exec(value);
  const match = bracketed ?? plain;
  if (!match) return null;

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const rawHostname = match[1]!;
  const authorityHost = bracketed ? `[${rawHostname}]` : rawHostname;
  try {
    const parsed = new URL(`http://${authorityHost}:${port}`);
    if (parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return {
      hostname,
      port,
      normalized: isIP(hostname) === 6 ? `[${hostname}]:${port}` : `${hostname}:${port}`,
    };
  } catch {
    return null;
  }
}

function hostHeaders(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "host") values.push(rawHeaders[index + 1] ?? "");
  }
  return values;
}

export function validateLoopbackAuthority(
  rawHeaders: readonly string[],
  listenerHostname: string,
  listenerPort: number | null,
): LoopbackAuthorityDecision {
  if (listenerPort === null) return { allowed: false, reason: "listener-not-ready" };

  const hosts = hostHeaders(rawHeaders);
  if (hosts.length === 0) return { allowed: false, reason: "missing-host" };
  if (hosts.length !== 1) return { allowed: false, reason: "multiple-hosts" };

  const authority = parseAuthority(hosts[0]!);
  if (!authority) return { allowed: false, reason: "invalid-host" };
  if (authority.port !== listenerPort) {
    return { allowed: false, reason: "port-mismatch", authority: authority.normalized };
  }

  const listener = canonicalizeHostname(listenerHostname);
  if (!LOOPBACK_AUTHORITY_HOSTS.has(authority.hostname) && authority.hostname !== listener) {
    return {
      allowed: false,
      reason: "hostname-not-allowed",
      authority: authority.normalized,
    };
  }

  return { allowed: true, authority: authority.normalized };
}
