import type { BookmarkRecord } from "@codesesh/core/runtime/state";
import { normalizeSessionReference, type SessionReference } from "@codesesh/core/contract";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseSessionReferencePayload(value: unknown): SessionReference | null {
  if (
    !isRecord(value) ||
    typeof value.agentName !== "string" ||
    typeof value.sessionId !== "string" ||
    !value.agentName.trim() ||
    !value.sessionId
  ) {
    return null;
  }
  return normalizeSessionReference({
    agentName: value.agentName.trim().toLowerCase(),
    sessionId: value.sessionId,
  });
}

export function parseBookmarkReference(value: unknown): SessionReference | null {
  if (!isRecord(value)) return null;

  const reference = parseSessionReferencePayload(value.reference);
  if (reference) return reference;

  if (
    typeof value.agentKey !== "string" ||
    typeof value.sessionId !== "string" ||
    !value.agentKey.trim() ||
    !value.sessionId
  ) {
    return null;
  }
  return normalizeSessionReference({
    agentName: value.agentKey.trim().toLowerCase(),
    sessionId: value.sessionId,
  });
}

export function parseBookmarkImport(value: unknown): BookmarkRecord | null {
  if (!isRecord(value)) return null;
  const reference = parseBookmarkReference(value);
  if (!reference) return null;

  const timestamp = value.bookmarkedAt ?? value.bookmarked_at;
  if (timestamp != null && (typeof timestamp !== "number" || !Number.isFinite(timestamp))) {
    return null;
  }
  return {
    reference,
    bookmarkedAt: typeof timestamp === "number" ? timestamp : Date.now(),
  };
}

export function sanitizeClientLogData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (CLIENT_LOG_STRING_FIELDS.has(key) && typeof item === "string") {
      if (key === "operation_id" && !UUID_PATTERN.test(item)) continue;
      sanitized[key] = item.slice(0, 300);
      continue;
    }
    if (
      CLIENT_LOG_NUMBER_FIELDS.has(key) &&
      typeof item === "number" &&
      Number.isFinite(item) &&
      item >= 0
    ) {
      sanitized[key] = item;
      continue;
    }
    if (CLIENT_LOG_NULLABLE_FIELDS.has(key) && item === null) sanitized[key] = null;
  }
  return sanitized;
}

const CLIENT_LOG_STRING_FIELDS = new Set([
  "agent",
  "error_name",
  "mode",
  "operation_id",
  "phase",
  "profiler_id",
  "reason",
  "request_key",
  "session",
  "source",
  "trigger",
]);

const CLIENT_LOG_NUMBER_FIELDS = new Set([
  "actual_duration_ms",
  "agents",
  "base_duration_ms",
  "commit_time_ms",
  "duration_ms",
  "error_status",
  "messages",
  "query_length",
  "results",
  "sessions",
  "start_time_ms",
]);

const CLIENT_LOG_NULLABLE_FIELDS = new Set(["agent", "session"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
