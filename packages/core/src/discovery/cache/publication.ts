import { randomUUID } from "node:crypto";
import type { SessionCacheMeta } from "../../agents/base.js";
import type { SessionDetail, SessionHead } from "../../types/index.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import type { SessionHeadChange } from "./db.js";
import { sessionDetailVersion } from "./detail-version.js";
import {
  prepareSessionChangesSearchIndex,
  prepareSessionSnapshotSearchIndex,
  discardPreparedSessionSearchIndex,
  writePreparedSessionSearchIndex,
  type SearchIndexSyncOptions,
  type SearchIndexSyncResult,
} from "./search-index-writer.js";
import { withSearchIndexDb } from "./schema.js";
import {
  deleteLegacyCacheFile,
  writeCachedSessionChanges,
  writeCachedSessionSnapshot,
  type SessionSnapshotCompleteness,
} from "./sessions.js";

export type DurableSessionPublication =
  | {
      kind: "snapshot";
      agentName: string;
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
      completeness: SessionSnapshotCompleteness;
      removedSessionIds: string[];
      publicationId?: string;
    }
  | {
      kind: "changes";
      agentName: string;
      changes: SessionHeadChange[];
      removedSessionIds: string[];
      meta: Record<string, SessionCacheMeta>;
      publicationId?: string;
    };

export type DurableSessionPublicationFailureStage = "prepare" | "cache" | "search_index" | "commit";

export type DurableSessionPublicationCommitResult =
  | {
      status: "committed";
      publicationId: string;
      searchIndex: SearchIndexSyncResult;
    }
  | {
      status: "rolled-back";
      publicationId: string;
      stage: DurableSessionPublicationFailureStage;
    };

function publicationSessionCount(publication: DurableSessionPublication): number {
  return publication.kind === "snapshot" ? publication.sessions.length : publication.changes.length;
}

function publicationSearchOptions(
  publication: DurableSessionPublication,
  options: SearchIndexSyncOptions,
  publicationId: string,
): SearchIndexSyncOptions {
  return {
    ...options,
    includePendingReindex: false,
    publicationId,
    ...(publication.kind === "snapshot"
      ? {
          completeness: publication.completeness,
          removedSessionIds: publication.removedSessionIds,
        }
      : {}),
    detailVersions: Object.fromEntries(
      Object.entries(publication.meta).map(([sessionId, meta]) => [
        sessionId,
        sessionDetailVersion(meta),
      ]),
    ),
  };
}

export function commitDurableSessionPublication(
  publication: DurableSessionPublication,
  loadSessionData: (sessionId: string) => SessionDetail,
  searchOptions: SearchIndexSyncOptions = {},
): DurableSessionPublicationCommitResult {
  const publicationId = publication.publicationId ?? randomUUID();
  let failureStage: DurableSessionPublicationFailureStage = "prepare";
  const diagnostics = getCoreDiagnostics();
  const detail = {
    agent: publication.agentName,
    publication_id: publicationId,
    sessions: publicationSessionCount(publication),
  };
  diagnostics?.info?.("search_index.publication_stage", { ...detail, stage: "started" });

  const searchIndex = withSearchIndexDb((db) => {
    const options = publicationSearchOptions(publication, searchOptions, publicationId);
    const prepared =
      publication.kind === "snapshot"
        ? prepareSessionSnapshotSearchIndex(
            db,
            publication.agentName,
            publication.sessions,
            loadSessionData,
            options,
          )
        : prepareSessionChangesSearchIndex(
            db,
            publication.agentName,
            publication.changes,
            publication.removedSessionIds,
            loadSessionData,
            options,
          );
    diagnostics?.info?.("search_index.publication_stage", { ...detail, stage: "prepared" });

    return db
      .transaction(() => {
        failureStage = "cache";
        if (publication.kind === "snapshot") {
          writeCachedSessionSnapshot(
            db,
            publication.agentName,
            publication.sessions,
            publication.meta,
            {
              completeness: publication.completeness,
              removedSessionIds: publication.removedSessionIds,
            },
          );
        } else {
          writeCachedSessionChanges(
            db,
            publication.agentName,
            publication.changes,
            publication.removedSessionIds,
            publication.meta,
          );
        }
        diagnostics?.info?.("search_index.publication_stage", {
          ...detail,
          stage: "cache_staged",
        });

        failureStage = "search_index";
        const result = writePreparedSessionSearchIndex(db, prepared);
        diagnostics?.info?.("search_index.publication_stage", {
          ...detail,
          stage: "search_staged",
        });
        failureStage = "commit";
        return result;
      })
      .immediate();
  });

  if (!searchIndex) {
    discardPreparedSessionSearchIndex(publicationId);
    diagnostics?.warn("search_index.publication_stage", {
      ...detail,
      stage: "rolled_back",
      failure_stage: failureStage,
    });
    return { status: "rolled-back", publicationId, stage: failureStage };
  }

  deleteLegacyCacheFile();
  diagnostics?.info?.("search_index.publication_stage", { ...detail, stage: "committed" });
  return { status: "committed", publicationId, searchIndex };
}
