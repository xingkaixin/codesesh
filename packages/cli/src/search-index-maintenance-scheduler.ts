import {
  readCachedSessions,
  readPendingSearchIndexMaintenance,
  type CachedResult,
  type IdentifiedSessionHead,
  type PersistedSessionHeadChange,
} from "@codesesh/core/runtime";
import type { SearchIndexMaintenanceStatus } from "@codesesh/core/contract";
import { toError } from "./errors.js";
import { appLogger } from "./logging.js";
import type { SearchIndexJobRunner } from "./search-index-job-runner.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

const MAINTENANCE_BATCH_SIZE = 4;

type StatusListener = (status: SearchIndexMaintenanceStatus) => void;

export class SearchIndexMaintenanceScheduler {
  private readonly pendingAgents = new Set<string>();
  private readonly completedAgents = new Set<string>();
  private readonly failedAgents = new Set<string>();
  private readonly cachedSessionsByAgent = new Map<string, CachedResult>();
  private currentAgent: string | undefined;
  private remaining: number | undefined;
  private pumpPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly runner: SearchIndexJobRunner,
    private readonly onStatus: StatusListener,
  ) {}

  enqueue(agentName: string): void {
    if (this.stopped) return;
    this.pendingAgents.add(agentName);
    this.completedAgents.delete(agentName);
    this.failedAgents.delete(agentName);
    this.cachedSessionsByAgent.delete(agentName);
    this.startPump();
  }

  stop(): void {
    this.stopped = true;
    this.pendingAgents.clear();
    this.cachedSessionsByAgent.clear();
    this.publishStatus();
  }

  async waitForIdle(): Promise<void> {
    while (this.pumpPromise) await this.pumpPromise;
  }

  private startPump(): void {
    if (this.pumpPromise || this.stopped) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      if (this.pendingAgents.size > 0 && !this.stopped) this.startPump();
    });
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.pendingAgents.size > 0) {
      const agentName = this.pendingAgents.values().next().value as string;
      this.pendingAgents.delete(agentName);
      this.currentAgent = agentName;
      try {
        await this.runBatch(agentName);
      } catch (error) {
        this.cachedSessionsByAgent.delete(agentName);
        if (!this.stopped) {
          this.failedAgents.add(agentName);
          appLogger.error("search_index.maintenance_failed", {
            agent: agentName,
            error: toError(error),
          });
        }
      } finally {
        this.currentAgent = undefined;
        this.remaining = undefined;
        this.publishStatus();
      }
    }
  }

  private async runBatch(agentName: string): Promise<void> {
    const pending = readPendingSearchIndexMaintenance(agentName, MAINTENANCE_BATCH_SIZE);
    if (!pending) throw new Error("Search index storage is unavailable");
    if (pending.total === 0) {
      this.completedAgents.add(agentName);
      return;
    }
    this.remaining = pending.total;
    this.publishStatus();

    let cached = this.cachedSessionsByAgent.get(agentName);
    if (!cached) {
      const outcome = readCachedSessions(agentName);
      if (outcome.status === "failed") {
        throw new Error(`Session cache read failed for ${agentName}`);
      }
      cached = outcome.value ?? undefined;
    }
    if (!cached) throw new Error(`Session cache is unavailable for ${agentName}`);
    this.cachedSessionsByAgent.set(agentName, cached);
    const sessionsById = new Map(
      cached.sessions.map((session, sortIndex) => [
        session.reference.sessionId,
        { session, sortIndex },
      ]),
    );
    const changes = pending.sessionIds.flatMap(
      (sessionId): PersistedSessionHeadChange<IdentifiedSessionHead>[] => {
        const change = sessionsById.get(sessionId);
        return change ? [change] : [];
      },
    );
    if (changes.length === 0) {
      throw new Error(`No cached sessions matched pending maintenance for ${agentName}`);
    }

    const meta = Object.fromEntries(
      changes.flatMap(({ session }) => {
        const sessionId = session.reference.sessionId;
        const sessionMeta = cached.meta[sessionId];
        return sessionMeta ? [[sessionId, sessionMeta]] : [];
      }),
    );
    const job: SearchIndexWorkerJob = {
      kind: "maintenance",
      context: "search.maintenance",
      agentName,
      changes,
      removedSessionIds: [],
      meta,
      searchIndexOptions: { isBulk: false },
    };
    appLogger.info("search_index.maintenance_batch_started", {
      agent: agentName,
      batch_sessions: changes.length,
      remaining: pending.total,
    });
    await this.runner.enqueueMaintenance("search.maintenance", [job]);

    const next = readPendingSearchIndexMaintenance(agentName, MAINTENANCE_BATCH_SIZE);
    if (!next) throw new Error("Search index storage became unavailable");
    if (next.total >= pending.total) {
      throw new Error(`Search index maintenance made no progress for ${agentName}`);
    }
    appLogger.info("search_index.maintenance_batch_completed", {
      agent: agentName,
      indexed: pending.total - next.total,
      remaining: next.total,
    });
    if (next.total > 0) {
      this.pendingAgents.add(agentName);
      this.remaining = next.total;
      return;
    }
    this.cachedSessionsByAgent.delete(agentName);
    this.completedAgents.add(agentName);
  }

  private publishStatus(): void {
    this.onStatus({
      active: this.currentAgent != null || this.pendingAgents.size > 0,
      pendingAgents: [...this.pendingAgents],
      ...(this.currentAgent ? { currentAgent: this.currentAgent } : {}),
      ...(this.remaining != null ? { remaining: this.remaining } : {}),
      completedAgents: [...this.completedAgents],
      failedAgents: [...this.failedAgents],
    });
  }
}
