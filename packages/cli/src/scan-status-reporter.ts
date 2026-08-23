import type {
  ScanCompletion,
  ScanStatusEvent,
  SearchIndexMaintenanceStatus,
} from "@codesesh/core/contract";
import type { AgentScanProgress } from "@codesesh/core/runtime/agents";
import type { BackfillAttemptRef, BackfillLifecycle } from "./backfill-lifecycle.js";

import { LatestValueThrottle } from "./latest-value-throttle.js";
import { ScanStatusModel } from "./scan-status-model.js";
import { appLogger } from "./logging.js";

const STATUS_PROGRESS_INTERVAL_MS = 100;

type StatusChangedListener = (event: ScanStatusEvent) => void;

export interface ScanStatusReporterOptions {
  /** Session count for an agent in the current snapshot. */
  sessionCount(agentName: string): number | undefined;
  backfills: BackfillLifecycle;
}

/**
 * Owns scan-status projection and fan-out: the ScanStatusModel, the
 * per-key progress throttles, and the status listener set. The sync engine
 * reports lifecycle transitions here and keeps only refresh orchestration.
 */
export class ScanStatusReporter {
  private readonly scanStatus = new ScanStatusModel();
  private readonly listeners = new Set<StatusChangedListener>();
  private readonly progressThrottles = new Map<string, LatestValueThrottle<void>>();
  private shuttingDown = false;

  constructor(private readonly options: ScanStatusReporterOptions) {}

  subscribe(listener: StatusChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): ScanStatusEvent {
    return this.scanStatus.snapshot();
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
    this.cancelProgressStatuses();
  }

  /** Record a failure without publishing (initialization-time bookkeeping). */
  recordAgentFailure(agentName: string, message: string, sessionCount?: number): void {
    this.scanStatus.failAgent(agentName, message, sessionCount);
  }

  failAgent(agentName: string, message: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(this.scanStatus.failAgent(agentName, message));
  }

  updateSearchIndexMaintenance(status: SearchIndexMaintenanceStatus): void {
    this.publishStatus(this.scanStatus.updateSearchIndexMaintenance(status));
  }

  startScanBatch(agentNames: string[], phase: ScanStatusEvent["phase"]): void {
    const sessionCounts = Object.fromEntries(
      agentNames.map((agentName) => [agentName, this.options.sessionCount(agentName) ?? 0]),
    );
    this.publishStatus(this.scanStatus.startBatch(agentNames, phase, sessionCounts));
  }

  setScanPhase(phase: ScanStatusEvent["phase"]): void {
    this.publishStatus(this.scanStatus.setPhase(phase));
  }

  beginAgentScan(agentName: string): void {
    this.cancelProgressStatus(`scan:${agentName}`);
    if (!this.scanStatus.snapshot().active) this.startScanBatch([agentName], "scanning");
    this.publishStatus(
      this.scanStatus.beginAgent(agentName, this.options.sessionCount(agentName) ?? 0),
    );
  }

  updateAgentScanProgress(
    agentName: string,
    progress: AgentScanProgress,
    backfillAttempt?: BackfillAttemptRef,
  ): void {
    const backfills = this.options.backfills;
    if (backfillAttempt) {
      const key = `backfill:${agentName}`;
      const current = backfills.stateFor(agentName);
      if (current?.status !== "running" || current.attemptId !== backfillAttempt.attemptId) {
        return;
      }
      const currentPhase = current.progress?.phase ?? "scanning";
      const nextPhase = progress.phase ?? "scanning";
      if (currentPhase && currentPhase !== nextPhase) this.flushProgressStatus(key);
      if (
        backfills.updateProgress(backfillAttempt, {
          phase: progress.phase,
          total: progress.total,
          processed: progress.processed,
          sessions: progress.sessions,
        })
      ) {
        this.publishProgressStatus(
          key,
          nextPhase,
          this.scanStatus.updateBackfill(backfills.status()),
        );
      }
      return;
    }
    const key = `scan:${agentName}`;
    const currentPhase = this.scanStatus.snapshot().agentStatuses[agentName]?.status;
    const nextPhase = progress.phase === "finalizing" ? "finalizing" : "scanning";
    if (currentPhase && currentPhase !== nextPhase) this.flushProgressStatus(key);
    const status = this.scanStatus.updateAgent(agentName, progress);
    this.publishProgressStatus(key, status?.agentStatuses[agentName]?.status ?? nextPhase, status);
  }

  beginAgentPublishing(agentName: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(this.scanStatus.publishAgent(agentName));
  }

  queueAgentPublication(agentName: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(this.scanStatus.queueAgentPublication(agentName));
  }

  finishAgentScan(agentName: string, completion: ScanCompletion): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(
      this.scanStatus.finishAgent(agentName, this.options.sessionCount(agentName), completion),
    );
  }

  finishScanBatch(): void {
    this.flushProgressStatuses("scan:");
    this.publishStatus(this.scanStatus.finishBatch());
  }

  publishBackfillStatus(): void {
    this.publishStatus(this.scanStatus.updateBackfill(this.options.backfills.status()));
  }

  publishBackfillProgress(key: string, phase: string): void {
    this.publishProgressStatus(
      key,
      phase,
      this.scanStatus.updateBackfill(this.options.backfills.status()),
    );
  }

  flushProgressStatus(key: string): void {
    const throttle = this.progressThrottles.get(key);
    if (!throttle) return;
    throttle.flush();
    throttle.cancel();
    this.progressThrottles.delete(key);
  }

  cancelProgressStatus(key: string): void {
    const throttle = this.progressThrottles.get(key);
    if (!throttle) return;
    throttle.cancel();
    this.progressThrottles.delete(key);
  }

  flushProgressStatuses(prefix: string): void {
    for (const key of this.progressThrottles.keys()) {
      if (key.startsWith(prefix)) this.flushProgressStatus(key);
    }
  }

  cancelProgressStatuses(): void {
    for (const throttle of this.progressThrottles.values()) throttle.cancel();
    this.progressThrottles.clear();
  }

  private publishStatus(event: ScanStatusEvent | null): void {
    if (!event || this.shuttingDown) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        appLogger.error("scan.status_listener.error", { error });
      }
    }
  }

  private publishProgressStatus(key: string, phase: string, event: ScanStatusEvent | null): void {
    if (!event) return;
    let throttle = this.progressThrottles.get(key);
    if (!throttle) {
      throttle = new LatestValueThrottle<void>(STATUS_PROGRESS_INTERVAL_MS, () => {
        this.publishStatus(this.scanStatus.snapshot());
      });
      this.progressThrottles.set(key, throttle);
    }
    throttle.push(undefined, phase);
  }
}
