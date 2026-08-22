import type { SessionDetail, SessionHead } from "../../types/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import {
  SEARCH_INDEX_BULK_SYNC_THRESHOLD,
  type PersistedSessionHeadChange,
  type SQLiteStatement,
} from "./db.js";
import { advanceAnalyticsRevision } from "./analytics-revision.js";
import {
  appendPlainText,
  buildSessionContentFromMessages,
  normalizeMessages,
  assertSessionProjectIdentities,
  requireSessionProjectIdentity,
} from "./messages.js";
import { withSearchIndexDb } from "./connection.js";
import { runSearchIndexWrite } from "./schema.js";
import { sessionDetailVersion } from "./detail-version.js";
import {
  deletePublicationPayloads,
  discardPublicationStaging,
  readPublicationPayloads,
  stagePublicationPayloads,
} from "./publication-staging.js";
import {
  prepareSessionMaterializationWriter,
  type SessionMaterializationEntry,
} from "./session-materialization-writer.js";
import {
  detailVersionFromMetaJson,
  readSearchIndexState,
  searchIndexEntryNeedsUpdate,
  sessionContentHash,
  sessionDetailFactsHash,
  targetDetailVersion,
  type SearchIndexState,
  type SearchIndexSyncOptions,
} from "./search-index-state.js";

export {
  readPendingSearchIndexMaintenance,
  searchIndexStateQuery,
  type PendingSearchIndexMaintenance,
  type SearchIndexSyncOptions,
} from "./search-index-state.js";

export interface SearchIndexSyncFailure {
  sessionId: string;
  reason: "parse-failed" | "superseded";
  message?: string;
}

export interface SearchIndexSyncResult {
  agentName: string;
  mode: "bulk" | "incremental";
  sessions: number;
  changed: number;
  deleted: number;
  indexed: number;
  skipped: number;
  failures?: SearchIndexSyncFailure[];
  durationMs: number;
  rebuildDurationMs?: number;
  planningDurationMs: number;
  getSessionDataCalls: number;
  reusedMaterializations: number;
  getSessionDataDurationMs: number;
  materializationDurationMs: number;
}

const SEARCH_INDEX_COMMIT_CHUNK_SIZE = 64;

interface LoadedSearchIndexEntryBase {
  session: SessionHead;
  contentText: string;
  contentHash: string;
  detailVersion: string;
  sortIndex: number;
  messageCount: number;
}

interface ParsedSearchIndexEntry extends LoadedSearchIndexEntryBase, SessionMaterializationEntry {
  materialization: "replace";
}

interface ReusedSearchIndexEntry extends LoadedSearchIndexEntryBase {
  materialization: "reuse";
}

type LoadedSearchIndexEntry = ParsedSearchIndexEntry | ReusedSearchIndexEntry;

interface SearchIndexRowWriteOptions {
  verifySupersession?: boolean;
}

interface SearchIndexLoadTiming {
  calls: number;
  reused: number;
  getSessionDataMs: number;
  materializationMs: number;
}

type SearchIndexPlanRequest =
  | { kind: "snapshot"; sessions: SessionHead[] }
  | {
      kind: "changes";
      changes: PersistedSessionHeadChange[];
      removedSessionIds: readonly string[];
    };

interface SearchIndexPlan {
  agentName: string;
  mode: "bulk" | "incremental";
  sessionCount: number;
  changes: PersistedSessionHeadChange[];
  removedSessionIds: string[];
  detailVersionBySessionId: Map<string, string>;
  reusableMessageCountBySessionId: Map<string, number>;
  needsRebuild: boolean;
  startedAt: number;
}

interface SearchIndexPlanInput {
  agentName: string;
  sessionCount: number;
  candidates: PersistedSessionHeadChange[];
  removedSessionIds: string[];
  state: SearchIndexState;
  options: SearchIndexSyncOptions;
  startedAt: number;
}

/** Full snapshots bound memory with durable chunks; targeted changes retain one atomic write. */
type LargeBacklogWriteStrategy = "atomic" | "chunked";

interface PreparedSearchIndexPublication {
  agentName: string;
  mode: "bulk" | "incremental";
  sessions: number;
  changed: number;
  removedSessionIds: string[];
  entries: LoadedSearchIndexEntry[];
  publicationId?: string;
  /** Full entries stored outside the live tables until the atomic commit. */
  preStaged: number;
  failures: SearchIndexSyncFailure[];
  needsRebuild: boolean;
  startedAt: number;
  planningDurationMs: number;
  loadTiming: SearchIndexLoadTiming;
}

function createSearchIndexLoadTiming(): SearchIndexLoadTiming {
  return { calls: 0, reused: 0, getSessionDataMs: 0, materializationMs: 0 };
}

function shouldBulkSyncSearchIndex(options: SearchIndexSyncOptions, changedCount: number): boolean {
  if (options.isBulk != null) {
    return options.isBulk;
  }

  const threshold = options.bulkThreshold ?? SEARCH_INDEX_BULK_SYNC_THRESHOLD;
  return threshold > 0 && changedCount >= threshold;
}

function loadSearchIndexEntry(
  agentName: string,
  change: PersistedSessionHeadChange,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersion: string,
  failures: SearchIndexSyncFailure[],
  timing: SearchIndexLoadTiming,
): LoadedSearchIndexEntry | null {
  const sessionId = change.session.reference.sessionId;
  try {
    timing.calls += 1;
    const loadStartedAt = performance.now();
    let data: SessionDetail;
    try {
      data = loadSessionData(sessionId);
    } finally {
      timing.getSessionDataMs += performance.now() - loadStartedAt;
    }
    const materializationStartedAt = performance.now();
    try {
      const messages = normalizeMessages(data);
      const identity = requireSessionProjectIdentity(agentName, change.session);
      return {
        session: change.session,
        materialization: "replace",
        messages,
        contentText: buildSessionContentFromMessages(data.title ?? change.session.title, messages),
        contentHash: sessionContentHash(change.session),
        fileActivity: extractSessionFileActivity(agentName, sessionId, identity.key, data.messages),
        sortIndex: change.sortIndex,
        messageCount: messages.length,
        detailVersion,
      };
    } finally {
      timing.materializationMs += performance.now() - materializationStartedAt;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ sessionId, reason: "parse-failed", message });
    getCoreDiagnostics()?.warn("search_index.session_parse_failed", {
      agent: agentName,
      session_id: sessionId,
      message,
    });
    return null;
  }
}

function loadReusedSearchIndexEntry(
  readCachedContent: SQLiteStatement,
  agentName: string,
  change: PersistedSessionHeadChange,
  detailVersion: string,
  expectedMessageCount: number,
  timing: SearchIndexLoadTiming,
): ReusedSearchIndexEntry | null {
  const sessionId = change.session.reference.sessionId;
  const startedAt = performance.now();
  try {
    const rows = readCachedContent.all(agentName, sessionId) as Array<{
      content_text?: string | null;
    }>;
    if (rows.length !== expectedMessageCount) return null;

    const chunks: string[] = [];
    appendPlainText(change.session.title, chunks);
    for (const row of rows) appendPlainText(row.content_text, chunks);
    timing.reused += 1;
    return {
      session: change.session,
      materialization: "reuse",
      contentText: chunks.join("\n"),
      contentHash: sessionContentHash(change.session),
      detailVersion,
      sortIndex: change.sortIndex,
      messageCount: rows.length,
    };
  } finally {
    timing.materializationMs += performance.now() - startedAt;
  }
}

function* loadSearchIndexEntries(
  db: SQLiteDatabase,
  agentName: string,
  changes: Iterable<PersistedSessionHeadChange>,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersionFor: (sessionId: string) => string,
  failures: SearchIndexSyncFailure[],
  timing: SearchIndexLoadTiming,
  reusableMessageCountBySessionId: ReadonlyMap<string, number>,
): Generator<LoadedSearchIndexEntry> {
  const readCachedContent = db.prepare(
    "SELECT content_text FROM messages WHERE agent_name = ? AND session_id = ? ORDER BY message_index",
  );
  for (const change of changes) {
    const sessionId = change.session.reference.sessionId;
    const detailVersion = detailVersionFor(sessionId);
    const reusableMessageCount = reusableMessageCountBySessionId.get(sessionId);
    if (reusableMessageCount !== undefined) {
      const reused = loadReusedSearchIndexEntry(
        readCachedContent,
        agentName,
        change,
        detailVersion,
        reusableMessageCount,
        timing,
      );
      if (reused) {
        yield reused;
        continue;
      }
    }
    const entry = loadSearchIndexEntry(
      agentName,
      change,
      loadSessionData,
      detailVersion,
      failures,
      timing,
    );
    if (entry) yield entry;
  }
}

function writeSearchIndexRows(
  db: SQLiteDatabase,
  agentName: string,
  removedSessionIds: string[],
  entries: Iterable<LoadedSearchIndexEntry>,
  failures: SearchIndexSyncFailure[],
  options: SearchIndexRowWriteOptions = {},
): number {
  const { verifySupersession = true } = options;
  const deleteRow = db.prepare(
    "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
  );
  const materialization = prepareSessionMaterializationWriter(db, agentName);
  const upsertRow = db.prepare(`
    INSERT INTO session_documents(
      agent_name,
      session_id,
      title,
      content_text,
      content_hash,
      indexed_message_count,
      detail_version,
      indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      title = excluded.title,
      content_text = excluded.content_text,
      content_hash = excluded.content_hash,
      indexed_message_count = excluded.indexed_message_count,
      detail_version = excluded.detail_version,
      indexed_at = excluded.indexed_at
  `);

  const readCurrentMeta = db.prepare(
    "SELECT meta_json FROM sessions WHERE agent_name = ? AND session_id = ?",
  );

  const clearPendingReindex = db.prepare(
    "DELETE FROM pending_reindex WHERE agent_name = ? AND session_id = ?",
  );

  for (const sessionId of new Set(removedSessionIds)) {
    deleteRow.run(agentName, sessionId);
    materialization.deleteSession(sessionId);
    clearPendingReindex.run(agentName, sessionId);
  }

  let indexed = 0;
  for (const entry of entries) {
    const sessionId = entry.session.reference.sessionId;
    if (verifySupersession) {
      const current = readCurrentMeta.get(agentName, sessionId) as
        | { meta_json?: string | null }
        | undefined;
      if (entry.detailVersion !== detailVersionFromMetaJson(current?.meta_json)) {
        failures.push({ sessionId, reason: "superseded" });
        continue;
      }
    }
    clearPendingReindex.run(agentName, sessionId);
    if (entry.materialization === "reuse") {
      materialization.reuseSessionHead(entry.session, entry.sortIndex);
    } else {
      materialization.writeSession(entry);
    }
    upsertRow.run(
      agentName,
      sessionId,
      entry.session.title,
      entry.contentText,
      entry.contentHash,
      entry.messageCount,
      entry.detailVersion,
      Date.now(),
    );
    indexed += 1;
  }
  return indexed;
}

/**
 * Loaded entries carry full message bodies, so a backlog larger than one commit
 * chunk cannot be held in memory at once — a first-time index of a large agent
 * (multi-GB codex rollouts) used to OOM the search-index worker. Larger
 * backlogs are serialized into a shadow table in chunks. The final transaction
 * streams those payloads into the live tables, keeping memory bounded without
 * publishing any detail facts ahead of their session heads.
 */
function loadOrPreStageEntries(
  db: SQLiteDatabase,
  agentName: string,
  changes: PersistedSessionHeadChange[],
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersionFor: (sessionId: string) => string,
  failures: SearchIndexSyncFailure[],
  timing: SearchIndexLoadTiming,
  reusableMessageCountBySessionId: ReadonlyMap<string, number>,
  publicationId?: string,
): { entries: LoadedSearchIndexEntry[]; preStaged: number } {
  if (changes.length <= SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    return {
      entries: [
        ...loadSearchIndexEntries(
          db,
          agentName,
          changes,
          loadSessionData,
          detailVersionFor,
          failures,
          timing,
          reusableMessageCountBySessionId,
        ),
      ],
      preStaged: 0,
    };
  }

  if (!publicationId) {
    throw new Error("Large durable publications require a publication id");
  }

  let preStaged = 0;
  for (let offset = 0; offset < changes.length; offset += SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    const chunk = changes.slice(offset, offset + SEARCH_INDEX_COMMIT_CHUNK_SIZE);
    runSearchIndexWrite(db, false, () => {
      const entries = loadSearchIndexEntries(
        db,
        agentName,
        chunk,
        loadSessionData,
        detailVersionFor,
        failures,
        timing,
        reusableMessageCountBySessionId,
      );
      preStaged += stagePublicationPayloads(
        db,
        publicationId,
        agentName,
        (function* () {
          for (const entry of entries) {
            yield {
              sessionId: entry.session.reference.sessionId,
              json: JSON.stringify(entry),
            };
          }
        })(),
      );
    });
  }
  getCoreDiagnostics()?.info?.("search_index.pre_staged", {
    agent: agentName,
    changed: changes.length,
    staged: preStaged,
  });
  return { entries: [], preStaged };
}

function readSearchIndexPlanInput(
  db: SQLiteDatabase,
  agentName: string,
  request: SearchIndexPlanRequest,
  options: SearchIndexSyncOptions,
): SearchIndexPlanInput {
  const startedAt = performance.now();
  let candidates: PersistedSessionHeadChange[];
  let removedSessionIds: string[];
  let sessionCount: number;

  if (request.kind === "snapshot") {
    const existingRows = db
      .prepare("SELECT session_id FROM session_documents WHERE agent_name = ? ORDER BY id")
      .all(agentName) as Array<{ session_id?: string }>;
    const includedSessionIds = new Set(
      request.sessions.map((session) => session.reference.sessionId),
    );
    const sortIndexBySessionId = new Map(
      request.sessions.map((session, sortIndex) => [session.reference.sessionId, sortIndex]),
    );
    const explicitRemovedSessionIds = new Set(options.removedSessionIds ?? []);
    const completeness = options.completeness ?? "complete";
    removedSessionIds = existingRows
      .map((row) => String(row.session_id))
      .filter(
        (sessionId) =>
          explicitRemovedSessionIds.has(sessionId) ||
          (completeness === "complete" && !includedSessionIds.has(sessionId)),
      );
    candidates = request.sessions.map((session) => ({
      session,
      sortIndex: sortIndexBySessionId.get(session.reference.sessionId) ?? 0,
    }));
    sessionCount = request.sessions.length;
  } else {
    candidates = request.changes;
    removedSessionIds = [...new Set(request.removedSessionIds)];
    sessionCount = request.changes.length;
  }

  const state = readSearchIndexState(
    db,
    agentName,
    candidates.map(({ session }) => session.reference.sessionId),
  );

  return {
    agentName,
    sessionCount,
    candidates,
    removedSessionIds,
    state,
    options,
    startedAt,
  };
}

function createSearchIndexPlan(input: SearchIndexPlanInput): SearchIndexPlan {
  const changes = input.candidates.filter(({ session }) =>
    searchIndexEntryNeedsUpdate(input.state, session, input.options),
  );
  const detailVersionBySessionId = new Map(
    changes.map(({ session }) => {
      const sessionId = session.reference.sessionId;
      return [sessionId, targetDetailVersion(input.state, sessionId, input.options)];
    }),
  );
  const unversionedDetail = sessionDetailVersion(null);
  // Reuse is safe only when the source-backed detail version, normalized message rows,
  // and every message-derived head fact still match.
  const reusableMessageCountBySessionId = new Map(
    changes.flatMap(({ session }) => {
      const sessionId = session.reference.sessionId;
      const targetVersion = detailVersionBySessionId.get(sessionId);
      const storedMessageCount = input.state.messageCountBySessionId.get(sessionId);
      const canReuse =
        typeof targetVersion === "string" &&
        targetVersion !== unversionedDetail &&
        typeof storedMessageCount === "number" &&
        input.state.detailVersionBySessionId.get(sessionId) === targetVersion &&
        input.state.indexedMessageCountBySessionId.get(sessionId) === storedMessageCount &&
        input.state.publishedDetailFactsHashBySessionId.get(sessionId) ===
          sessionDetailFactsHash(session) &&
        !input.state.pendingReindexSessionIds.has(sessionId);
      return canReuse ? ([[sessionId, storedMessageCount]] as const) : [];
    }),
  );
  const changedCount = input.removedSessionIds.length + changes.length;
  const isBulk = shouldBulkSyncSearchIndex(input.options, changedCount);

  return {
    agentName: input.agentName,
    mode: isBulk ? "bulk" : "incremental",
    sessionCount: input.sessionCount,
    changes,
    removedSessionIds: input.removedSessionIds,
    detailVersionBySessionId,
    reusableMessageCountBySessionId,
    needsRebuild: isBulk && changedCount > 0,
    startedAt: input.startedAt,
  };
}

function planSearchIndexWrite(
  db: SQLiteDatabase,
  agentName: string,
  request: SearchIndexPlanRequest,
  options: SearchIndexSyncOptions,
): SearchIndexPlan {
  return createSearchIndexPlan(readSearchIndexPlanInput(db, agentName, request, options));
}

function detailVersionForPlan(plan: SearchIndexPlan, sessionId: string): string {
  return plan.detailVersionBySessionId.get(sessionId) ?? sessionDetailVersion(null);
}

function prepareSearchIndexPublication(
  db: SQLiteDatabase,
  plan: SearchIndexPlan,
  loadSessionData: (sessionId: string) => SessionDetail,
  publicationId?: string,
): PreparedSearchIndexPublication {
  getCoreDiagnostics()?.info?.("search_index.publication_plan", {
    agent: plan.agentName,
    sessions: plan.sessionCount,
    changed: plan.changes.length,
    removed: plan.removedSessionIds.length,
    mode: plan.mode,
    planning_ms: Math.round(performance.now() - plan.startedAt),
  });
  const failures: SearchIndexSyncFailure[] = [];
  const planningDurationMs = performance.now() - plan.startedAt;
  const loadTiming = createSearchIndexLoadTiming();
  const { entries, preStaged } = loadOrPreStageEntries(
    db,
    plan.agentName,
    plan.changes,
    loadSessionData,
    (sessionId) => detailVersionForPlan(plan, sessionId),
    failures,
    loadTiming,
    plan.reusableMessageCountBySessionId,
    publicationId,
  );

  return {
    agentName: plan.agentName,
    mode: plan.mode,
    sessions: plan.sessionCount,
    changed: plan.changes.length,
    removedSessionIds: plan.removedSessionIds,
    entries,
    publicationId,
    preStaged,
    failures,
    needsRebuild: plan.needsRebuild,
    startedAt: plan.startedAt,
    planningDurationMs,
    loadTiming,
  };
}

export function prepareSessionSnapshotSearchIndex(
  db: SQLiteDatabase,
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): PreparedSearchIndexPublication {
  return prepareSearchIndexPublication(
    db,
    planSearchIndexWrite(db, agentName, { kind: "snapshot", sessions }, options),
    loadSessionData,
    options.publicationId,
  );
}

export function prepareSessionChangesSearchIndex(
  db: SQLiteDatabase,
  agentName: string,
  changes: PersistedSessionHeadChange[],
  removedSessionIds: string[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): PreparedSearchIndexPublication {
  return prepareSearchIndexPublication(
    db,
    planSearchIndexWrite(db, agentName, { kind: "changes", changes, removedSessionIds }, options),
    loadSessionData,
    options.publicationId,
  );
}

export function writePreparedSessionSearchIndex(
  db: SQLiteDatabase,
  publication: PreparedSearchIndexPublication,
): SearchIndexSyncResult {
  let indexed = 0;
  const { rebuildDurationMs } = runSearchIndexWrite(
    db,
    publication.needsRebuild,
    () => {
      const entries = (function* (): Generator<LoadedSearchIndexEntry> {
        yield* publication.entries;
        if (!publication.publicationId || publication.preStaged === 0) return;
        for (const payload of readPublicationPayloads(
          db,
          publication.publicationId,
          publication.agentName,
        )) {
          yield JSON.parse(payload) as LoadedSearchIndexEntry;
        }
      })();
      indexed += writeSearchIndexRows(
        db,
        publication.agentName,
        publication.removedSessionIds,
        entries,
        publication.failures,
      );
      if (publication.publicationId) {
        deletePublicationPayloads(db, publication.publicationId, publication.agentName);
      }
    },
    "caller",
  );

  return {
    agentName: publication.agentName,
    mode: publication.mode,
    sessions: publication.sessions,
    changed: publication.changed,
    deleted: publication.removedSessionIds.length,
    indexed,
    skipped: publication.changed - indexed,
    failures: publication.failures.length > 0 ? publication.failures : undefined,
    durationMs: performance.now() - publication.startedAt,
    rebuildDurationMs,
    planningDurationMs: publication.planningDurationMs,
    getSessionDataCalls: publication.loadTiming.calls,
    reusedMaterializations: publication.loadTiming.reused,
    getSessionDataDurationMs: publication.loadTiming.getSessionDataMs,
    materializationDurationMs: publication.loadTiming.materializationMs,
  };
}

export function discardPreparedSessionSearchIndex(publicationId: string, agentName: string): void {
  withSearchIndexDb((db) =>
    db.transaction(() => discardPublicationStaging(db, publicationId, agentName)).immediate(),
  );
}

function searchIndexSyncResult(
  plan: SearchIndexPlan,
  indexed: number,
  failures: SearchIndexSyncFailure[],
  planningDurationMs: number,
  loadTiming: SearchIndexLoadTiming,
  rebuildDurationMs?: number,
  mode = plan.mode,
): SearchIndexSyncResult {
  return {
    agentName: plan.agentName,
    mode,
    sessions: plan.sessionCount,
    changed: plan.changes.length,
    deleted: plan.removedSessionIds.length,
    indexed,
    skipped: plan.changes.length - indexed,
    failures: failures.length > 0 ? failures : undefined,
    durationMs: performance.now() - plan.startedAt,
    rebuildDurationMs,
    planningDurationMs,
    getSessionDataCalls: loadTiming.calls,
    reusedMaterializations: loadTiming.reused,
    getSessionDataDurationMs: loadTiming.getSessionDataMs,
    materializationDurationMs: loadTiming.materializationMs,
  };
}

function executeSearchIndexPlan(
  db: SQLiteDatabase,
  plan: SearchIndexPlan,
  loadSessionData: (sessionId: string) => SessionDetail,
  largeBacklogStrategy: LargeBacklogWriteStrategy,
): SearchIndexSyncResult {
  let indexed = 0;
  const failures: SearchIndexSyncFailure[] = [];
  const planningDurationMs = performance.now() - plan.startedAt;
  const loadTiming = createSearchIndexLoadTiming();
  const loadEntries = (changes: PersistedSessionHeadChange[]) =>
    loadSearchIndexEntries(
      db,
      plan.agentName,
      changes,
      loadSessionData,
      (sessionId) => detailVersionForPlan(plan, sessionId),
      failures,
      loadTiming,
      plan.reusableMessageCountBySessionId,
    );

  if (largeBacklogStrategy === "chunked" && plan.changes.length > SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    runSearchIndexWrite(db, false, () => {
      indexed += writeSearchIndexRows(db, plan.agentName, plan.removedSessionIds, [], failures);
      if (plan.removedSessionIds.length > 0) advanceAnalyticsRevision(db);
    });
    for (let offset = 0; offset < plan.changes.length; offset += SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
      const chunk = plan.changes.slice(offset, offset + SEARCH_INDEX_COMMIT_CHUNK_SIZE);
      runSearchIndexWrite(db, false, () => {
        const chunkIndexed = writeSearchIndexRows(
          db,
          plan.agentName,
          [],
          loadEntries(chunk),
          failures,
        );
        indexed += chunkIndexed;
        if (chunkIndexed > 0) advanceAnalyticsRevision(db);
      });
    }
    return searchIndexSyncResult(
      plan,
      indexed,
      failures,
      planningDurationMs,
      loadTiming,
      undefined,
      "incremental",
    );
  }

  const { rebuildDurationMs } = runSearchIndexWrite(db, plan.needsRebuild, () => {
    indexed = writeSearchIndexRows(
      db,
      plan.agentName,
      plan.removedSessionIds,
      loadEntries(plan.changes),
      failures,
    );
    if (indexed > 0 || plan.removedSessionIds.length > 0) advanceAnalyticsRevision(db);
  });
  return searchIndexSyncResult(
    plan,
    indexed,
    failures,
    planningDurationMs,
    loadTiming,
    rebuildDurationMs,
  );
}

export function syncSessionSearchIndex(
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): SearchIndexSyncResult | null {
  assertSessionProjectIdentities(agentName, sessions);
  return withSearchIndexDb((db) =>
    executeSearchIndexPlan(
      db,
      planSearchIndexWrite(db, agentName, { kind: "snapshot", sessions }, options),
      loadSessionData,
      "chunked",
    ),
  );
}

export function syncSessionSearchIndexChanges(
  agentName: string,
  changes: PersistedSessionHeadChange[],
  removedSessionIds: string[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): SearchIndexSyncResult | null {
  if (changes.length === 0 && removedSessionIds.length === 0) {
    return {
      agentName,
      mode: "incremental",
      sessions: 0,
      changed: 0,
      deleted: 0,
      indexed: 0,
      skipped: 0,
      durationMs: 0,
      planningDurationMs: 0,
      getSessionDataCalls: 0,
      reusedMaterializations: 0,
      getSessionDataDurationMs: 0,
      materializationDurationMs: 0,
    };
  }

  assertSessionProjectIdentities(
    agentName,
    changes.map(({ session }) => session),
  );

  return withSearchIndexDb((db) =>
    executeSearchIndexPlan(
      db,
      planSearchIndexWrite(db, agentName, { kind: "changes", changes, removedSessionIds }, options),
      loadSessionData,
      "atomic",
    ),
  );
}
