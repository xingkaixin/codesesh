export interface SessionReference {
  readonly agentName: string;
  readonly sessionId: string;
}

export interface SessionIdentity {
  /** The only authoritative session identity. */
  readonly reference: SessionReference;
  /** @deprecated Compatibility projection of `reference.sessionId`. */
  readonly id: string;
  /** @deprecated Compatibility projection serialized from `reference`. */
  readonly slug: string;
}

export const UNKNOWN_AGENT_NAME = "unknown";

export function normalizeSessionReference(reference: SessionReference): SessionReference {
  return {
    agentName: reference.agentName.trim().toLowerCase(),
    sessionId: reference.sessionId,
  };
}

export function parseSessionReference(value: string): SessionReference | null {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  const agentName = value.slice(0, separatorIndex).trim().toLowerCase();
  if (!agentName) return null;
  return {
    agentName,
    sessionId: value.slice(separatorIndex + 1),
  };
}

export function formatSessionReference(reference: SessionReference): string {
  const normalized = normalizeSessionReference(reference);
  return `${normalized.agentName}/${normalized.sessionId}`;
}

/** Canonical key for maps and sets keyed by session identity. */
export function getSessionReferenceKey(reference: SessionReference): string {
  return formatSessionReference(reference);
}

export function createSessionIdentity(reference: SessionReference): SessionIdentity {
  const normalized = normalizeSessionReference(reference);
  return {
    reference: normalized,
    id: normalized.sessionId,
    slug: formatSessionReference(normalized),
  };
}

export function assertSessionIdentity(identity: SessionIdentity, agentName?: string): void {
  const normalized = normalizeSessionReference(identity.reference);
  const expectedAgentName = agentName?.trim().toLowerCase();
  if (
    identity.reference.agentName !== normalized.agentName ||
    identity.id !== normalized.sessionId ||
    identity.slug !== formatSessionReference(normalized) ||
    (expectedAgentName != null && normalized.agentName !== expectedAgentName)
  ) {
    throw new Error("Session identity fields disagree");
  }
}

export function getSessionAgentKey(session: Pick<SessionIdentity, "reference">): string {
  return normalizeSessionReference(session.reference).agentName;
}

/**
 * Canonical URL path for an agent. Callers must never concatenate the name
 * themselves: both routers match on the raw path, so an unencoded segment can
 * split, truncate, or turn into a query or fragment.
 */
export function agentRoutePath(agentName: string): string {
  return `/${encodeURIComponent(agentName.trim().toLowerCase())}`;
}

/**
 * Canonical URL path for a session reference, shared by web routes and HTTP
 * endpoints. Each segment is encoded independently, so an opaque id keeps `/`,
 * `?`, `#` and `%` intact through React Router and Hono alike.
 */
export function sessionRoutePath(reference: SessionReference): string {
  const normalized = normalizeSessionReference(reference);
  return `${agentRoutePath(normalized.agentName)}/${encodeURIComponent(normalized.sessionId)}`;
}

/** Same as {@link sessionRoutePath}, for callers holding a session head. */
export function getSessionRoutePath(session: Pick<SessionIdentity, "reference">): string {
  return sessionRoutePath(session.reference);
}
