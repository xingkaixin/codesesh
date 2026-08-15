import type { BookmarkRecord } from "@codesesh/core";
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

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, item]) => {
        if (typeof item === "string") return [key, item.slice(0, 300)];
        if (typeof item === "number" || typeof item === "boolean" || item == null) {
          return [key, item];
        }
        return [key, String(item).slice(0, 300)];
      }),
  );
}
