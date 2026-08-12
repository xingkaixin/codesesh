import { createHash, randomUUID } from "node:crypto";

interface CursorPayload {
  version: 1;
  snapshot: string;
  view: string;
  query: string;
  offset: number;
}

interface PaginationRequest {
  cursor?: string;
  limit: number;
  query: URLSearchParams;
  snapshotIdentity: object;
  viewIdentity: object;
}

export type PaginationResult<T> =
  | { kind: "page"; items: T[]; nextCursor?: string }
  | { kind: "invalid_cursor" }
  | { kind: "stale_snapshot" };

const identityVersions = new WeakMap<object, string>();

function identityVersion(identity: object): string {
  const existing = identityVersions.get(identity);
  if (existing) return existing;
  const version = randomUUID();
  identityVersions.set(identity, version);
  return version;
}

function queryFingerprint(params: URLSearchParams): string {
  const canonical = new URLSearchParams(params);
  canonical.delete("cursor");
  canonical.delete("limit");
  canonical.sort();
  return createHash("sha256").update(canonical.toString()).digest("base64url");
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;

  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      typeof value.snapshot !== "string" ||
      typeof value.view !== "string" ||
      typeof value.query !== "string" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset! <= 0
    ) {
      return null;
    }
    return value as CursorPayload;
  } catch {
    return null;
  }
}

/** Keeps every page on the same immutable scan and alias read-model versions. */
export function paginateSessionSnapshot<T>(
  items: T[],
  request: PaginationRequest,
): PaginationResult<T> {
  const snapshot = identityVersion(request.snapshotIdentity);
  const view = identityVersion(request.viewIdentity);
  const query = queryFingerprint(request.query);
  let offset = 0;

  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (!cursor || cursor.query !== query) return { kind: "invalid_cursor" };
    if (cursor.snapshot !== snapshot || cursor.view !== view) {
      return { kind: "stale_snapshot" };
    }
    if (cursor.offset >= items.length) return { kind: "invalid_cursor" };
    offset = cursor.offset;
  }

  const end = Math.min(offset + request.limit, items.length);
  const nextCursor =
    end < items.length
      ? encodeCursor({ version: 1, snapshot, view, query, offset: end })
      : undefined;
  return {
    kind: "page",
    items: items.slice(offset, end),
    ...(nextCursor ? { nextCursor } : {}),
  };
}
