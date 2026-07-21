import { getCoreDiagnostics } from "./diagnostics.js";

/** Narrow to a plain object (excludes arrays and null); undefined on mismatch. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Narrow to a string; undefined on mismatch. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Narrow to a finite number (rejects NaN/Infinity); undefined on mismatch. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Narrow to an array; undefined on mismatch. */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

const reportedFieldMismatches = new Set<string>();

/**
 * Reports a field shape mismatch once per (agentName, field) for the life of
 * the process — an upstream format drift hits every line of a session file,
 * and warning per line would flood the diagnostics sink for no added signal.
 */
export function reportFieldMismatch(agentName: string, field: string): void {
  const key = `${agentName}\0${field}`;
  if (reportedFieldMismatches.has(key)) return;
  reportedFieldMismatches.add(key);
  getCoreDiagnostics()?.warn("agent.field_shape_mismatch", { agentName, field });
}
