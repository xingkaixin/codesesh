export const AGENT_UNAVAILABLE_DURING_SCAN_ERROR_CODE = "agent-unavailable-during-scan";

export type ScanRefreshWorkerErrorCode = typeof AGENT_UNAVAILABLE_DURING_SCAN_ERROR_CODE;

export class AgentUnavailableDuringScanError extends Error {
  readonly code = AGENT_UNAVAILABLE_DURING_SCAN_ERROR_CODE;

  constructor(agentName: string) {
    super(`Agent ${agentName} became unavailable during scan`);
    this.name = "AgentUnavailableDuringScanError";
  }
}
