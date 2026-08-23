import type { IdentifiedSessionHead } from "@codesesh/core/runtime/discovery";
import type { SessionsUpdatedEvent } from "@codesesh/core/contract";
import type { LiveSessionIndex } from "./live-session-index.js";
import { appLogger } from "./logging.js";
import type { SearchIndexPublisher } from "./search-index-publisher.js";
import type {
  SearchIndexPublicationProgress,
  SearchIndexWorkerJob,
} from "./search-index-worker.js";
import type { StagedWorkerRun } from "./worker-runner.js";

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
  stagedRun?: StagedWorkerRun;
  onPublishing?: () => void;
  onPublicationProgress?: (progress: SearchIndexPublicationProgress) => void;
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
      ...(publication.onPublicationProgress
        ? { onProgress: publication.onPublicationProgress }
        : {}),
    });
    const diffStartedAt = performance.now();
    const event = this.sessionIndex.commitAgentSessions(
      publication.agentName,
      publication.sessions,
      publication.candidateChangedIds,
    );
    const diffDuration = performance.now() - diffStartedAt;
    const result: SessionPublicationResult = { durableCommitted: true, event, diffDuration };
    this.runPostCommit(publication, "worker_commit", () => publication.stagedRun?.commit());
    this.runPostCommit(publication, "callback", () => publication.onCommitted?.(result));
    this.runPostCommit(publication, "notification", () =>
      this.emit({
        agentName: publication.agentName,
        sessions: this.sessionIndex.snapshot().byAgent[publication.agentName] ?? [],
        event,
      }),
    );
    this.runPostCommit(publication, "logging", () =>
      appLogger.info("session.publication.published", {
        publication_id: publicationId,
        context: publication.context,
        agent: publication.agentName,
        sessions: publication.sessions.length,
        has_event: event != null,
      }),
    );
    return result;
  }

  private runPostCommit(
    publication: SessionPublication,
    stage: "worker_commit" | "callback" | "notification" | "logging",
    action: () => void,
  ): void {
    try {
      action();
    } catch (error) {
      try {
        appLogger.error("session.publication.post_commit_error", {
          context: publication.context,
          agent: publication.agentName,
          stage,
          error,
        });
      } catch {}
    }
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
