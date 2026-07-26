export interface SessionReference {
  agentName: string;
  sessionId: string;
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

export function getSessionAgentKey(session: { slug: string }): string {
  return parseSessionReference(session.slug)?.agentName ?? UNKNOWN_AGENT_NAME;
}
