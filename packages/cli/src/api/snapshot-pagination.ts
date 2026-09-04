import { createHash, randomUUID } from "node:crypto";

interface CursorPayload {
  version: 1;
  snapshot: string;
  offset: number;
}

interface PaginationRequest {
  cursor?: string;
  limit: number;
  query: URLSearchParams;
}

interface PaginationSnapshot<T, View> {
  items: readonly T[];
  view: View;
}

interface RetainedSnapshot<T, View> extends PaginationSnapshot<T, View> {
  query: string;
  expiresAt: number;
}

type PaginationResult<T, View> =
  | { kind: "page"; items: T[]; view: View; nextCursor?: string }
  | { kind: "invalid_cursor" }
  | { kind: "stale_snapshot" };

const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_LIMIT = 32;

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

export function createSnapshotPaginator<T, View>() {
  const snapshotsBySource = new WeakMap<object, Map<string, RetainedSnapshot<T, View>>>();

  return function paginateSnapshot(
    source: object,
    request: PaginationRequest,
    load: () => PaginationSnapshot<T, View>,
  ): PaginationResult<T, View> {
    const snapshots = snapshotsBySource.get(source) ?? new Map<string, RetainedSnapshot<T, View>>();
    const now = Date.now();
    for (const [id, snapshot] of snapshots) {
      if (snapshot.expiresAt <= now) snapshots.delete(id);
    }
    const query = queryFingerprint(request.query);
    let snapshot: RetainedSnapshot<T, View>;
    let snapshotId: string;
    let offset = 0;

    if (request.cursor) {
      const cursor = decodeCursor(request.cursor);
      if (!cursor) return { kind: "invalid_cursor" };
      const retained = snapshots.get(cursor.snapshot);
      if (!retained) return { kind: "stale_snapshot" };
      if (retained.query !== query || cursor.offset >= retained.items.length) {
        return { kind: "invalid_cursor" };
      }
      snapshot = retained;
      snapshotId = cursor.snapshot;
      offset = cursor.offset;
    } else {
      const loaded = load();
      snapshot = { ...loaded, items: [...loaded.items], query, expiresAt: now + SNAPSHOT_TTL_MS };
      snapshotId = randomUUID();
    }

    const end = Math.min(offset + request.limit, snapshot.items.length);
    const nextCursor =
      end < snapshot.items.length
        ? encodeCursor({ version: 1, snapshot: snapshotId, offset: end })
        : undefined;
    if (!request.cursor && nextCursor) {
      if (snapshots.size >= SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(snapshotId, snapshot);
      snapshotsBySource.set(source, snapshots);
    }
    return {
      kind: "page",
      items: snapshot.items.slice(offset, end),
      view: snapshot.view,
      ...(nextCursor ? { nextCursor } : {}),
    };
  };
}
