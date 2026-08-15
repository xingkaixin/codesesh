import type { Context } from "hono";
import type { BookmarkRecord, BookmarkView } from "@codesesh/core";
import { createSessionIndex } from "@codesesh/core/contract";
import {
  SessionAliasValidationError,
  StateStorageUnavailableError,
  deleteBookmark,
  deleteSessionAlias,
  importBookmarks,
  listBookmarks,
  loadCachedSessionHeads,
  materializeBookmarkViews,
  upsertBookmark,
  upsertSessionAlias,
} from "@codesesh/core";
import { KNOWN_AGENT_NAME_SET } from "./handlers.js";
import { parseBookmarkImport, parseBookmarkReference } from "./request-payloads.js";
import { getSnapshotAggregation } from "./snapshot-aggregation.js";
import type { ScanResultSource } from "./scan-sources.js";
import {
  decorateBookmark,
  invalidateAliasView,
  loadAliasView,
  type AliasView,
} from "./session-aliases-view.js";

interface SessionAliasPayload {
  alias?: unknown;
}

function withStorageErrors<TResult, TFallback>(
  handler: () => TResult,
  onUnavailable: () => TFallback,
): TResult | TFallback {
  try {
    return handler();
  } catch (error) {
    if (error instanceof StateStorageUnavailableError) {
      return onUnavailable();
    }
    throw error;
  }
}

function materializeStoredBookmarks(
  scanSource: ScanResultSource,
  bookmarks: readonly BookmarkRecord[],
  aliases: AliasView,
): BookmarkView[] {
  const snapshot = scanSource.getSnapshot();
  const sessionIndex = getSnapshotAggregation(
    scanSource,
    snapshot.sessions,
    ["bookmark-session-index"],
    () => createSessionIndex(snapshot.sessions),
  );
  return materializeBookmarkViews(bookmarks, {
    liveSessionsByReference: sessionIndex.byRouteKey,
    knownAgentNames: KNOWN_AGENT_NAME_SET,
    resolveCachedSessions: loadCachedSessionHeads,
  }).map((bookmark) => decorateBookmark(bookmark, aliases));
}

export function handleGetBookmarks(c: Context, scanSource: ScanResultSource) {
  return withStorageErrors(
    () => {
      const aliases = loadAliasView();
      const bookmarks = materializeStoredBookmarks(scanSource, listBookmarks(), aliases);
      return c.json({
        bookmarks,
        storageAvailable: true,
      });
    },
    () => c.json({ bookmarks: [], storageAvailable: false }),
  );
}

/**
 * Write endpoints must reject unknown agents: rows for agents that do not
 * exist accumulate in state.db forever — materialization filters on the known
 * set, so they are never visible and never garbage-collected.
 */
function isKnownAgentKey(agentKey: string): boolean {
  return KNOWN_AGENT_NAME_SET.has(agentKey.trim().toLowerCase());
}

export async function handlePutBookmark(c: Context) {
  const payload = parseBookmarkReference(await c.req.json().catch(() => null));
  if (!payload) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }
  if (!isKnownAgentKey(payload.agentName)) {
    return c.json({ error: `Unknown agent: ${payload.agentName}` }, 400);
  }

  return withStorageErrors(
    () => c.json({ bookmark: upsertBookmark(payload), storageAvailable: true }),
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
}

export async function handleImportBookmarks(c: Context, scanSource: ScanResultSource) {
  const payload = await c.req.json().catch(() => null);
  if (!Array.isArray(payload)) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  const parsed = payload
    .map((entry) => parseBookmarkImport(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (parsed.length !== payload.length) {
    return c.json({ error: "Invalid bookmark payload" }, 400);
  }

  // Legacy exports may reference agents this build no longer knows; skip them
  // (reporting the count) instead of rejecting the rest of the import.
  const bookmarks = parsed.filter((entry) => isKnownAgentKey(entry.reference.agentName));
  const skippedUnknownAgents = parsed.length - bookmarks.length;

  return withStorageErrors(
    () => {
      const imported = importBookmarks(bookmarks);
      const views = materializeStoredBookmarks(scanSource, imported, loadAliasView());
      return c.json({
        bookmarks: views,
        storageAvailable: true,
        ...(skippedUnknownAgents > 0 ? { skippedUnknownAgents } : {}),
      });
    },
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
}

export function handleDeleteBookmark(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  if (!agentKey || !sessionId) {
    return c.json({ error: "Missing bookmark identifier" }, 400);
  }
  if (!isKnownAgentKey(agentKey)) {
    return c.json({ error: `Unknown agent: ${agentKey}` }, 400);
  }

  return withStorageErrors(
    () => {
      deleteBookmark({ agentName: agentKey, sessionId });
      return c.json({ ok: true, storageAvailable: true });
    },
    () => c.json({ error: "Bookmark storage is unavailable" }, 503),
  );
}

export async function handlePutSessionAlias(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  const payload = (await c.req.json().catch(() => null)) as SessionAliasPayload | null;
  const aliasValue = payload?.alias;
  if (!agentKey || !sessionId || typeof aliasValue !== "string") {
    return c.json({ error: "Invalid session alias payload" }, 400);
  }
  if (!isKnownAgentKey(agentKey)) {
    return c.json({ error: `Unknown agent: ${agentKey}` }, 400);
  }

  try {
    return withStorageErrors(
      () => {
        const alias = upsertSessionAlias({ agentName: agentKey, sessionId }, aliasValue);
        invalidateAliasView();
        return c.json({ alias });
      },
      () => c.json({ error: "Session alias storage is unavailable" }, 503),
    );
  } catch (error) {
    if (error instanceof SessionAliasValidationError) {
      return c.json({ error: "Session alias must be non-empty and at most 160 characters" }, 400);
    }
    throw error;
  }
}

export function handleDeleteSessionAlias(c: Context) {
  const agentKey = c.req.param("agent");
  const sessionId = c.req.param("id");
  if (!agentKey || !sessionId) {
    return c.json({ error: "Missing session alias identifier" }, 400);
  }
  if (!isKnownAgentKey(agentKey)) {
    return c.json({ error: `Unknown agent: ${agentKey}` }, 400);
  }

  return withStorageErrors(
    () => {
      deleteSessionAlias({ agentName: agentKey, sessionId });
      invalidateAliasView();
      return c.json({ ok: true });
    },
    () => c.json({ error: "Session alias storage is unavailable" }, 503),
  );
}
