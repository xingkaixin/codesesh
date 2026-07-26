export interface SessionReference {
  agentName: string;
  sessionId: string;
}

export const UNKNOWN_AGENT_NAME = "unknown";

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
  return `${reference.agentName.trim().toLowerCase()}/${reference.sessionId}`;
}

export function getSessionAgentKey(session: { slug: string }): string {
  return parseSessionReference(session.slug)?.agentName ?? UNKNOWN_AGENT_NAME;
}
