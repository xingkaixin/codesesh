import type { SessionDetail, SessionHead } from "../../types/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { SEARCH_INDEX_BULK_SYNC_THRESHOLD, type PersistedSessionHeadChange } from "./db.js";
import { advanceAnalyticsRevision } from "./analytics-revision.js";
import {
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
}

const SEARCH_INDEX_COMMIT_CHUNK_SIZE = 64;

interface LoadedSearchIndexEntry extends SessionMaterializationEntry {
  contentText: string;
  contentHash: string;
  detailVersion: string;
}

interface SearchIndexRowWriteOptions {
  verifySupersession?: boolean;
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
): LoadedSearchIndexEntry | null {
  const sessionId = change.session.reference.sessionId;
  try {
    const data = loadSessionData(sessionId);
    const messages = normalizeMessages(data);
    const identity = requireSessionProjectIdentity(agentName, change.session);
    return {
      session: change.session,
      messages,
      contentText: buildSessionContentFromMessages(data.title ?? change.session.title, messages),
      contentHash: sessionContentHash(change.session),
      fileActivity: extractSessionFileActivity(agentName, sessionId, identity.key, data.messages),
      sortIndex: change.sortIndex,
      detailVersion,
    };
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

function* loadSearchIndexEntries(
  agentName: string,
  changes: Iterable<PersistedSessionHeadChange>,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersionFor: (sessionId: string) => string,
  failures: SearchIndexSyncFailure[],
): Generator<LoadedSearchIndexEntry> {
  for (const change of changes) {
    const sessionId = change.session.reference.sessionId;
    const entry = loadSearchIndexEntry(
      agentName,
      change,
      loadSessionData,
      detailVersionFor(sessionId),
      failures,
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
    materialization.writeSession(entry);
    upsertRow.run(
      agentName,
      sessionId,
      entry.session.title,
      entry.contentText,
      entry.contentHash,
      entry.messages.length,
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
  publicationId?: string,
): { entries: LoadedSearchIndexEntry[]; preStaged: number } {
  if (changes.length <= SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    return {
      entries: [
        ...loadSearchIndexEntries(agentName, changes, loadSessionData, detailVersionFor, failures),
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
        agentName,
        chunk,
        loadSessionData,
        detailVersionFor,
        failures,
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
  const changedCount = input.removedSessionIds.length + changes.length;
  const isBulk = shouldBulkSyncSearchIndex(input.options, changedCount);

  return {
    agentName: input.agentName,
    mode: isBulk ? "bulk" : "incremental",
    sessionCount: input.sessionCount,
    changes,
    removedSessionIds: input.removedSessionIds,
    detailVersionBySessionId,
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
  const { entries, preStaged } = loadOrPreStageEntries(
    db,
    plan.agentName,
    plan.changes,
    loadSessionData,
    (sessionId) => detailVersionForPlan(plan, sessionId),
    failures,
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
  const loadEntries = (changes: PersistedSessionHeadChange[]) =>
    loadSearchIndexEntries(
      plan.agentName,
      changes,
      loadSessionData,
      (sessionId) => detailVersionForPlan(plan, sessionId),
      failures,
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
    return searchIndexSyncResult(plan, indexed, failures, undefined, "incremental");
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
  return searchIndexSyncResult(plan, indexed, failures, rebuildDurationMs);
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
