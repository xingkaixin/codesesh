import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  closeCacheStorage,
  createRegisteredAgents,
  scanSessions,
  type LiveSnapshot,
  type ScanOptions,
} from "@codesesh/core/runtime";
import type {
  AgentScanStatus,
  BackfillStatus,
  SearchIndexMaintenanceStatus,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";
import { mergeSessionsUpdatedEvents } from "@codesesh/core/contract";
import { AgentSyncEngine } from "./agent-sync-engine.js";
import { appLogger } from "./logging.js";
import { SessionWatcher } from "./session-watcher.js";
import { ThreadWorkerRunner, type WorkerRunner } from "./worker-runner.js";

export type {
  AgentScanStatus,
  BackfillStatus,
  SearchIndexMaintenanceStatus,
  ScanStatusEvent,
  SessionsUpdatedEvent,
};

type StoreListener = (event: SessionsUpdatedEvent) => void;
type ScanStatusListener = (event: ScanStatusEvent) => void;

export interface LiveScanStoreOptions {
  watchEnabled?: boolean;
  scanOptions?: ScanOptions;
  startupScanOptions?: Pick<ScanOptions, "from" | "to">;
  deferInitialRefresh?: boolean;
  workerRunner?: WorkerRunner;
}

const NEW_SESSION_EVENT_WINDOW_MS = 250;

export class LiveScanStore {
  private readonly watchEnabled: boolean;
  private readonly scanOptions: ScanOptions;
  private readonly startupScanOptions: Pick<ScanOptions, "from" | "to">;
  private readonly deferInitialRefresh: boolean;
  private readonly syncEngine: AgentSyncEngine;
  private listeners = new Set<StoreListener>();
  private watcher: SessionWatcher | null = null;
  private pendingEvent: SessionsUpdatedEvent | null = null;
  private pendingEventTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(options: LiveScanStoreOptions = {}) {
    this.watchEnabled = options.watchEnabled ?? true;
    this.scanOptions = options.scanOptions ?? {};
    this.startupScanOptions = options.startupScanOptions ?? {};
    this.deferInitialRefresh = options.deferInitialRefresh === true;
    const workerRunner =
      options.workerRunner ??
      new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));
    this.syncEngine = new AgentSyncEngine({
      startupScanOptions: this.startupScanOptions,
      workerRunner,
    });
    this.syncEngine.subscribeSessionsChanged((change) => {
      if (change.event) this.emit(change.event);
    });
  }

  async initialize(): Promise<void> {
    const startedAt = performance.now();
    appLogger.info("scan.initial.start", {
      watch_enabled: this.watchEnabled,
      agents: this.scanOptions.agents,
      use_cache: this.scanOptions.useCache ?? true,
      startup_from: this.startupScanOptions.from,
      startup_to: this.startupScanOptions.to,
      deferred: this.deferInitialRefresh || undefined,
    });
    const initialResult = await scanSessions({
      ...this.scanOptions,
      useCache: this.scanOptions.useCache ?? true,
      cacheOnly: this.deferInitialRefresh,
      writeCache: this.deferInitialRefresh ? false : this.scanOptions.writeCache,
      smartTagWorkerUrl: this.getSmartTagWorkerUrl() ?? undefined,
      includeSmartTags: this.deferInitialRefresh ? false : undefined,
    });
    this.syncEngine.initialize(initialResult, {
      cacheTimestamps: initialResult.cacheTimestamps,
      registeredAgents: createRegisteredAgents(),
      allowedAgents: this.getAllowedAgents(),
    });
    const snapshot = this.getSnapshot();
    const indexStartedAt = performance.now();
    if (!this.deferInitialRefresh) {
      // The snapshot is already served from memory, so an index-write failure
      // degrades search freshness rather than startup.
      await this.syncEngine.syncInitialIndex().catch((error: unknown) => {
        appLogger.error("scan.initial.index_failed", { error });
      });
    }
    const indexDuration = performance.now() - indexStartedAt;
    appLogger.info("scan.initial.done", {
      duration_ms: Math.round(performance.now() - startedAt),
      index_ms: this.deferInitialRefresh ? undefined : Math.round(indexDuration),
      deferred: this.deferInitialRefresh || undefined,
      sessions: snapshot.sessions.length,
      agents: Object.fromEntries(
        Object.entries(snapshot.byAgent).map(([key, value]) => [key, value.length]),
      ),
      agent_timings: initialResult.timings
        ? Object.fromEntries(
            Object.entries(initialResult.timings).map(([name, timing]) => [
              name,
              {
                total_ms: Math.round(timing.total),
                cache_load_ms: timing.cacheLoad != null ? Math.round(timing.cacheLoad) : undefined,
                check_changes_ms:
                  timing.checkChanges != null ? Math.round(timing.checkChanges) : undefined,
                scan_ms: timing.scan != null ? Math.round(timing.scan) : undefined,
                identity_ms: timing.identity != null ? Math.round(timing.identity) : undefined,
                tags_ms: timing.tags != null ? Math.round(timing.tags) : undefined,
                source_enumeration_ms:
                  timing.sourceEnumeration != null
                    ? Math.round(timing.sourceEnumeration)
                    : undefined,
                source_diff_ms:
                  timing.sourceDiff != null ? Math.round(timing.sourceDiff) : undefined,
                source_parse_ms:
                  timing.sourceParse != null ? Math.round(timing.sourceParse) : undefined,
                enumerated_sources: timing.enumeratedSources,
                changed_sources: timing.changedSources,
                processed_sources: timing.processedSources,
              },
            ]),
          )
        : undefined,
    });
    if (!this.watchEnabled) return;
    this.watcher = new SessionWatcher();
    this.watcher.onAgentsChanged((agentNames) => this.syncEngine.handleAgentsChanged(agentNames));
    this.watcher.start(snapshot.agents);
  }

  startBackgroundRefresh(): void {
    this.syncEngine.startBackgroundRefresh();
  }

  getSnapshot(): LiveSnapshot {
    return this.syncEngine.snapshot();
  }

  getScanStatus(): ScanStatusEvent {
    return this.syncEngine.status();
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeScanStatus(listener: ScanStatusListener): () => void {
    return this.syncEngine.subscribeStatusChanged(listener);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.pendingEventTimer) {
      clearTimeout(this.pendingEventTimer);
      this.pendingEventTimer = null;
    }
    await this.syncEngine.shutdown();
    this.pendingEvent = null;
    if (this.watcher) {
      await this.watcher.dispose();
      this.watcher = null;
    }
    closeCacheStorage();
  }

  private emit(event: SessionsUpdatedEvent): void {
    if (this.shuttingDown) return;
    if (this.pendingEvent || event.newSessionRefs.length > 0) {
      this.queueEvent(event);
      return;
    }
    this.emitNow(event);
  }

  private emitNow(event: SessionsUpdatedEvent): void {
    // Per-listener isolation: one broken SSE subscriber must not starve the
    // rest, and on the queueEvent timer path an escaped throw would be an
    // uncaught exception.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        appLogger.error("scan.sessions_listener.error", { error });
      }
    }
  }

  private queueEvent(event: SessionsUpdatedEvent): void {
    this.pendingEvent = this.pendingEvent
      ? mergeSessionsUpdatedEvents(this.pendingEvent, event)
      : event;
    if (this.pendingEventTimer) return;
    this.pendingEventTimer = setTimeout(() => {
      const pending = this.pendingEvent;
      this.pendingEvent = null;
      this.pendingEventTimer = null;
      if (pending) this.emitNow(pending);
    }, NEW_SESSION_EVENT_WINDOW_MS);
  }

  private getSmartTagWorkerUrl(): URL | null {
    const workerUrl = new URL("./smart-tag-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) return null;
    return workerUrl;
  }

  private getAllowedAgents(): Set<string> | null {
    if (!this.scanOptions.agents?.length) return null;
    return new Set(this.scanOptions.agents.map((agent) => agent.toLowerCase()));
  }
}
