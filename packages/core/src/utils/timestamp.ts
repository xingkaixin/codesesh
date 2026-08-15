import { getCoreDiagnostics } from "./diagnostics.js";

const TIMEZONE_SUFFIX_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export interface AgentTimestampOptions {
  /** Accept bare numeric strings as epoch milliseconds (Kimi wire format). */
  numericStrings?: boolean;
}

/**
 * The one timestamp parser for agent-supplied values of unknown shape.
 * Missing values are null without noise; present-but-unparseable values are
 * reported once and return null so callers pick their own fallback.
 */
export function parseAgentTimestamp(
  value: unknown,
  agentName: string,
  options: AgentTimestampOptions = {},
): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    reportTimestampParseFailure(agentName, value);
    return null;
  }
  if (typeof value !== "string") {
    reportTimestampParseFailure(agentName, value);
    return null;
  }

  const timestamp = value.trim().replace(" ", "T");
  if (!timestamp) return null;

  if (options.numericStrings) {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric)) return numeric;
  }

  const normalized = TIMEZONE_SUFFIX_PATTERN.test(timestamp) ? timestamp : `${timestamp}Z`;
  const timestampMs = Date.parse(normalized);
  if (Number.isFinite(timestampMs)) return timestampMs;

  reportTimestampParseFailure(agentName, value, normalized);
  return null;
}

function reportTimestampParseFailure(agentName: string, value: unknown, normalized?: string): void {
  getCoreDiagnostics()?.warn("agent.timestamp_parse_failed", {
    agentName,
    value: typeof value === "string" || typeof value === "number" ? value : typeof value,
    normalized,
  });
}
