import {
  buildAgentCacheMeta,
  type CachedResult,
  type LiveSnapshot,
  type IdentifiedSessionHead,
} from "@codesesh/core/runtime/discovery";
import { appLogger } from "./logging.js";
import type { SearchIndexJobRunner } from "./search-index-job-runner.js";
import type {
  SearchIndexPublicationProgress,
  SearchIndexWorkerJob,
} from "./search-index-worker.js";

export interface SearchIndexPublisherOptions {
  jobs: SearchIndexJobRunner;
  snapshot(): LiveSnapshot;
  agentSessions(agentName: string): IdentifiedSessionHead[];
  readCachedSessions(agentName: string): CachedResult | null;
}

/**
 * Owns search-index publication: job construction, publication-id minting,
 * and the durable enqueue with its logging protocol.
 */
export class SearchIndexPublisher {
  private nextPublicationId = 1;

  constructor(private readonly options: SearchIndexPublisherOptions) {}

  buildFullSearchIndexJobs(context: string): SearchIndexWorkerJob[] {
    const snapshot = this.options.snapshot();
    return snapshot.agents.flatMap((agent) => {
      if (!(agent.name in snapshot.byAgent)) return [];
      const cached = this.options.readCachedSessions(agent.name);
      return [
        cached
          ? {
              kind: "full",
              context,
              agentName: agent.name,
              sessions: cached.sessions,
              meta: cached.meta,
              completeness: "partial",
              removedSessionIds: [],
              searchIndexOptions: { includePendingReindex: false },
            }
          : {
              kind: "full",
              context,
              agentName: agent.name,
              sessions: this.options.agentSessions(agent.name),
              meta: buildAgentCacheMeta(agent),
              completeness: "partial",
              removedSessionIds: [],
              searchIndexOptions: { includePendingReindex: false },
            },
      ];
    });
  }

  publicationId(context: string, agentName?: string): string {
    const id = this.nextPublicationId++;
    return agentName ? `${context}:${agentName}:${id}` : `${context}:${id}`;
  }

  async commitSearchIndex(
    context: string,
    jobs: SearchIndexWorkerJob[],
    details: {
      publicationId: string;
      agent?: string;
      agents?: string[];
      onStarted?: () => void;
      onProgress?: (progress: SearchIndexPublicationProgress) => void;
    },
  ): Promise<void> {
    appLogger.info("session.publication.prepared", {
      publication_id: details.publicationId,
      context,
      agent: details.agent,
      agents: details.agents,
      jobs: jobs.length,
    });
    try {
      const publicationJobs = jobs.map((job) => ({
        ...job,
        publicationId: details.publicationId,
      }));
      await (details.onProgress
        ? this.options.jobs.enqueue(context, publicationJobs, details.onStarted, details.onProgress)
        : details.onStarted
          ? this.options.jobs.enqueue(context, publicationJobs, details.onStarted)
          : this.options.jobs.enqueue(context, publicationJobs));
    } catch (error) {
      appLogger.error("session.publication.failed", {
        publication_id: details.publicationId,
        context,
        agent: details.agent,
        stage: "search_index",
        error,
      });
      throw error;
    }
    appLogger.info("session.publication.index_committed", {
      publication_id: details.publicationId,
      context,
      agent: details.agent,
    });
  }
}
