import type { IdentifiedSessionHead } from "@codesesh/core/runtime";
import type { SessionsUpdatedEvent } from "@codesesh/core/contract";
import type { LiveSessionIndex } from "./live-session-index.js";
import { appLogger } from "./logging.js";
import type { SearchIndexPublisher } from "./search-index-publisher.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

export interface AgentSessionsChanged {
  agentName: string;
  sessions: IdentifiedSessionHead[];
  event: SessionsUpdatedEvent | null;
}

export interface SessionPublication {
  context: "scan.refresh" | "scan.backfill";
  agentName: string;
  sessions: IdentifiedSessionHead[];
  candidateChangedIds: string[];
  indexJob: SearchIndexWorkerJob;
  onPublishing?: () => void;
  onCommitted?: (result: SessionPublicationResult) => void;
}

export interface SessionPublicationResult {
  durableCommitted: true;
  event: SessionsUpdatedEvent | null;
  diffDuration: number;
}

type SessionsChangedListener = (change: AgentSessionsChanged) => void;

/**
 * Commits one durable search-index publication before updating the in-memory
 * session projection and notifying subscribers.
 */
export class SessionPublicationCoordinator {
  private readonly listeners = new Set<SessionsChangedListener>();
  private isShuttingDown = false;

  constructor(
    private readonly indexPublisher: SearchIndexPublisher,
    private readonly sessionIndex: LiveSessionIndex,
  ) {}

  subscribe(listener: SessionsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markShuttingDown(): void {
    this.isShuttingDown = true;
  }

  async commit(publication: SessionPublication): Promise<SessionPublicationResult> {
    const publicationId = this.indexPublisher.publicationId(
      publication.context,
      publication.agentName,
    );
    await this.indexPublisher.commitSearchIndex(publication.context, [publication.indexJob], {
      publicationId,
      agent: publication.agentName,
      ...(publication.onPublishing ? { onStarted: publication.onPublishing } : {}),
    });
    const diffStartedAt = performance.now();
    const event = this.sessionIndex.commitAgentSessions(
      publication.agentName,
      publication.sessions,
      publication.candidateChangedIds,
    );
    const diffDuration = performance.now() - diffStartedAt;
    const result: SessionPublicationResult = { durableCommitted: true, event, diffDuration };
    publication.onCommitted?.(result);
    this.emit({
      agentName: publication.agentName,
      sessions: this.sessionIndex.snapshot().byAgent[publication.agentName] ?? [],
      event,
    });
    appLogger.info("session.publication.published", {
      publication_id: publicationId,
      context: publication.context,
      agent: publication.agentName,
      sessions: publication.sessions.length,
      has_event: event != null,
    });
    return result;
  }

  private emit(change: AgentSessionsChanged): void {
    if (this.isShuttingDown) return;
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        appLogger.error("session.publication.post_commit_error", {
          agent: change.agentName,
          error,
        });
      }
    }
  }
}
