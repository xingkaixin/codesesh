import {
  readAgentLastFullSyncAt,
  readCachedSessions,
  type BaseAgent,
  type loadCachedSessions,
  type ScanOptions,
} from "@codesesh/core";
import type {
  BackfillAttemptRef,
  BackfillLifecycle,
  BackfillTerminalStatus,
} from "./backfill-lifecycle.js";
import { appLogger } from "./logging.js";
import type { ScanStatusReporter } from "./scan-status-reporter.js";

type CachedSessions = NonNullable<ReturnType<typeof loadCachedSessions>>;

export interface AgentBackfillSchedulerOptions {
  lifecycle: BackfillLifecycle;
  statusReporter: ScanStatusReporter;
  startupScanOptions: Pick<ScanOptions, "from" | "to">;
  runAttempt(attempt: BackfillAttemptRef): Promise<BackfillTerminalStatus>;
  scheduleRefresh(agentName: string, delayMs: number): void;
}

const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PARTIAL_BACKFILL_RETRY_DELAY_MS = 5 * 60 * 1000;
const CACHE_TRUNCATION_COVERAGE = 0.5;

/**
 * Owns backfill eligibility, queue progression, retries, and cache-integrity
 * validity windows. The sync engine supplies only the actual scan operation.
 */
export class AgentBackfillScheduler {
  private readonly cacheIntegrityValidUntilByAgent = new Map<string, number>();
  private isShuttingDown = false;

  constructor(private readonly options: AgentBackfillSchedulerOptions) {}

  needsBackfill(agent: BaseAgent, cached?: CachedSessions | null, reloadCached = false): boolean {
    const { from, to } = this.options.startupScanOptions;
    if (from == null && to == null) return false;
    const now = Date.now();
    if ((this.cacheIntegrityValidUntilByAgent.get(agent.name) ?? 0) >= now) return false;
    const lastSync = readAgentLastFullSyncAt(agent.name);
    if (lastSync.status === "failed") {
      appLogger.warn("scan.backfill.cache_state_unavailable", {
        agent: agent.name,
        state: "last_full_sync",
      });
      return false;
    }
    const lastSyncAt = lastSync.value;
    if (lastSyncAt == null || now - lastSyncAt > BACKFILL_INTERVAL_MS) {
      return agent.isAvailable();
    }
    if (agent.sessionSourceAccess.kind !== "enumerated") return false;
    if (!agent.isAvailable()) return false;

    let cachedSessions = cached;
    if (reloadCached || cached === undefined) {
      const outcome = readCachedSessions(agent.name);
      if (outcome.status === "failed") {
        appLogger.warn("scan.backfill.cache_state_unavailable", {
          agent: agent.name,
          state: "cached_sessions",
        });
        return false;
      }
      cachedSessions = outcome.value;
    }
    const sourceCount = agent.sessionSourceAccess.count();
    const cachedCount = cachedSessions?.sessions.length ?? 0;
    this.cacheIntegrityValidUntilByAgent.set(agent.name, lastSyncAt + BACKFILL_INTERVAL_MS);
    if (sourceCount > 0 && cachedCount / sourceCount < CACHE_TRUNCATION_COVERAGE) {
      appLogger.warn("scan.backfill.cache_truncated", {
        agent: agent.name,
        cached_sessions: cachedCount,
        source_files: sourceCount,
        last_sync_at: lastSyncAt,
      });
      return true;
    }
    return false;
  }

  enqueue(agentName: string): void {
    if (this.isShuttingDown || !this.options.lifecycle.enqueue(agentName)) return;
    this.options.statusReporter.publishBackfillStatus();
    this.pump();
  }

  shutdown(): void {
    this.isShuttingDown = true;
    this.options.lifecycle.cancelAll();
    this.cacheIntegrityValidUntilByAgent.clear();
  }

  private pump(): void {
    if (this.isShuttingDown) return;
    const attempt = this.options.lifecycle.startNext();
    if (!attempt) return;
    this.options.statusReporter.publishBackfillStatus();
    void this.options
      .runAttempt(attempt)
      .then((result) => this.complete(attempt, result))
      .catch((error) => this.reject(attempt, error));
  }

  private complete(attempt: BackfillAttemptRef, result: BackfillTerminalStatus): void {
    if (this.isShuttingDown) return;
    const current = this.options.lifecycle.stateFor(attempt.agentName);
    if (current?.status === "running" && current.attemptId === attempt.attemptId) {
      this.options.statusReporter.flushProgressStatus(`backfill:${attempt.agentName}`);
      if (this.options.lifecycle.complete(attempt, result)) {
        if (result === "failed") {
          this.cacheIntegrityValidUntilByAgent.delete(attempt.agentName);
        } else if (result === "committed") {
          if (current.completion?.completeness === "partial") {
            this.cacheIntegrityValidUntilByAgent.delete(attempt.agentName);
            this.options.scheduleRefresh(attempt.agentName, PARTIAL_BACKFILL_RETRY_DELAY_MS);
            appLogger.info("scan.backfill.retry_scheduled", {
              agent: attempt.agentName,
              delay_ms: PARTIAL_BACKFILL_RETRY_DELAY_MS,
            });
          } else {
            this.cacheIntegrityValidUntilByAgent.set(
              attempt.agentName,
              Date.now() + BACKFILL_INTERVAL_MS,
            );
          }
        }
        this.options.statusReporter.publishBackfillStatus();
      }
    }
    this.pump();
  }

  private reject(attempt: BackfillAttemptRef, error: unknown): void {
    appLogger.error("scan.backfill.queue_error", { agent: attempt.agentName, error });
    this.complete(attempt, "failed");
  }
}
