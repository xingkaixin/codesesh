import { getCoreDiagnostics } from "./diagnostics.js";

const TIMEZONE_SUFFIX_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseAgentTimestampMs(value: string, agentName: string): number {
  const timestamp = value.trim().replace(" ", "T");
  if (!timestamp) return 0;

  const normalized = TIMEZONE_SUFFIX_PATTERN.test(timestamp) ? timestamp : `${timestamp}Z`;
  const timestampMs = Date.parse(normalized);
  if (Number.isFinite(timestampMs)) return timestampMs;

  getCoreDiagnostics()?.warn("agent.timestamp_parse_failed", {
    agentName,
    value,
    normalized,
  });
  return 0;
}
