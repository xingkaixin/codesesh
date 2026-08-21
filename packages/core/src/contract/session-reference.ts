export interface SessionReference {
  readonly agentName: string;
  readonly sessionId: string;
}

export interface SessionIdentity {
  readonly reference: SessionReference;
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
  return {
    reference: normalizeSessionReference(reference),
  };
}

export function assertSessionIdentity(identity: SessionIdentity, agentName?: string): void {
  const normalized = normalizeSessionReference(identity.reference);
  const expectedAgentName = agentName?.trim().toLowerCase();
  if (identity.reference.agentName !== normalized.agentName) {
    throw new Error("Session reference is not normalized");
  }
  if (expectedAgentName != null && normalized.agentName !== expectedAgentName) {
    throw new Error(
      `Session reference agent "${normalized.agentName}" does not match "${expectedAgentName}"`,
    );
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
