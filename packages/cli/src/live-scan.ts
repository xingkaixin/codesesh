import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createRegisteredAgents,
  mergeSortedSessions,
  scanSessions,
  sortSessions,
  type BaseAgent,
  type ScanOptions,
  type LiveSnapshot,
  type SessionHead,
  type SessionReference,
} from "@codesesh/core";
import type {
  AgentScanStatus,
  BackfillStatus,
  ReferencedSessionHead,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";
import { AgentSyncEngine, type AgentSessionsChanged } from "./agent-sync-engine.js";
import { appLogger } from "./logging.js";
import { SessionWatcher } from "./session-watcher.js";
import { ThreadWorkerRunner, type WorkerRunner } from "./worker-runner.js";

export type { AgentScanStatus, BackfillStatus, ScanStatusEvent, SessionsUpdatedEvent };

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

function mergeEvents(
  previous: SessionsUpdatedEvent,
  next: SessionsUpdatedEvent,
): SessionsUpdatedEvent {
  const changedSessionHeads = new Map<string, ReferencedSessionHead>();
  const removedSessionRefs = new Map<string, SessionReference>();
  const sessionKey = (agentName: string, sessionId: string) => `${agentName}\0${sessionId}`;
  const addChanged = (item: ReferencedSessionHead) => {
    const key = sessionKey(item.reference.agentName, item.reference.sessionId);
    removedSessionRefs.delete(key);
    changedSessionHeads.set(key, item);
  };
  const addRemoved = (item: SessionReference) => {
    const key = sessionKey(item.agentName, item.sessionId);
    changedSessionHeads.delete(key);
    removedSessionRefs.set(key, item);
  };
  for (const item of previous.changedSessionHeads) addChanged(item);
  for (const item of previous.removedSessionRefs) addRemoved(item);
  for (const item of next.changedSessionHeads) addChanged(item);
  for (const item of next.removedSessionRefs) addRemoved(item);
  return {
    type: "sessions-updated",
    changedAgents: Array.from(new Set([...previous.changedAgents, ...next.changedAgents])),
    newSessions: previous.newSessions + next.newSessions,
    updatedSessions: previous.updatedSessions + next.updatedSessions,
    removedSessions: previous.removedSessions + next.removedSessions,
    totalSessions: next.totalSessions,
    timestamp: next.timestamp,
    changedSessionHeads: [...changedSessionHeads.values()],
    removedSessionRefs: [...removedSessionRefs.values()],
  };
}

export class LiveScanStore {
  private readonly watchEnabled: boolean;
  private readonly scanOptions: ScanOptions;
  private readonly startupScanOptions: Pick<ScanOptions, "from" | "to">;
  private readonly deferInitialRefresh: boolean;
  private readonly syncEngine: AgentSyncEngine;
  private agents: BaseAgent[] = [];
  private byAgent: Record<string, SessionHead[]> = {};
  private sessions: SessionHead[] = [];
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
      snapshot: () => this.getSnapshot(),
      startupScanOptions: this.startupScanOptions,
      workerRunner,
    });
    this.syncEngine.subscribeSessionsChanged((change) => this.applySessionsChanged(change));
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
      smartRefresh: false,
      cacheOnly: this.deferInitialRefresh,
      writeCache: this.deferInitialRefresh ? false : this.scanOptions.writeCache,
      smartTagWorkerUrl: this.getSmartTagWorkerUrl() ?? undefined,
      includeSmartTags: this.deferInitialRefresh ? false : undefined,
    });
    this.applyScanResult(initialResult);
    this.syncEngine.initialize(initialResult.cacheTimestamps);
    const indexStartedAt = performance.now();
    if (!this.deferInitialRefresh) await this.syncEngine.syncInitialIndex();
    const indexDuration = performance.now() - indexStartedAt;
    appLogger.info("scan.initial.done", {
      duration_ms: Math.round(performance.now() - startedAt),
      index_ms: this.deferInitialRefresh ? undefined : Math.round(indexDuration),
      deferred: this.deferInitialRefresh || undefined,
      sessions: this.sessions.length,
      agents: Object.fromEntries(
        Object.entries(this.byAgent).map(([key, value]) => [key, value.length]),
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
              },
            ]),
          )
        : undefined,
    });
    if (!this.watchEnabled) return;
    this.watcher = new SessionWatcher();
    this.watcher.onAgentsChanged((agentNames) => this.syncEngine.handleAgentsChanged(agentNames));
    this.watcher.start(this.agents);
  }

  startBackgroundRefresh(): void {
    this.syncEngine.startBackgroundRefresh();
  }

  getSnapshot(): LiveSnapshot {
    return { sessions: this.sessions, byAgent: this.byAgent, agents: this.agents };
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
  }

  private applySessionsChanged(change: AgentSessionsChanged): void {
    this.byAgent[change.agentName] = sortSessions(change.sessions);
    this.rebuildSessions();
    if (!change.event) return;
    change.event.totalSessions = this.sessions.length;
    this.emit(change.event);
  }

  private emit(event: SessionsUpdatedEvent): void {
    if (this.shuttingDown) return;
    if (this.pendingEvent || event.newSessions > 0) {
      this.queueEvent(event);
      return;
    }
    this.emitNow(event);
  }

  private emitNow(event: SessionsUpdatedEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private queueEvent(event: SessionsUpdatedEvent): void {
    this.pendingEvent = this.pendingEvent ? mergeEvents(this.pendingEvent, event) : event;
    if (this.pendingEventTimer) return;
    this.pendingEventTimer = setTimeout(() => {
      const pending = this.pendingEvent;
      this.pendingEvent = null;
      this.pendingEventTimer = null;
      if (pending) this.emitNow(pending);
    }, NEW_SESSION_EVENT_WINDOW_MS);
  }

  /**
   * Every byAgent shard is kept sorted by its two writers (applySessionsChanged
   * and applyScanResult), so combining them is a merge, not a sort.
   */
  private rebuildSessions(): void {
    this.sessions = mergeSortedSessions(Object.values(this.byAgent));
  }

  private getSmartTagWorkerUrl(): URL | null {
    const workerUrl = new URL("./smart-tag-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) return null;
    return workerUrl;
  }

  private applyScanResult(result: LiveSnapshot): void {
    const agentMap = new Map<string, BaseAgent>();
    const allowedAgents = this.getAllowedAgents();
    for (const agent of result.agents) agentMap.set(agent.name, agent);
    for (const agent of createRegisteredAgents()) {
      if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
    }
    this.agents = [...agentMap.values()].filter(
      (agent) => !allowedAgents || allowedAgents.has(agent.name.toLowerCase()),
    );
    this.byAgent = Object.fromEntries(
      this.agents.map((agent) => [agent.name, sortSessions(result.byAgent[agent.name] ?? [])]),
    );
    this.rebuildSessions();
  }

  private getAllowedAgents(): Set<string> | null {
    if (!this.scanOptions.agents?.length) return null;
    return new Set(this.scanOptions.agents.map((agent) => agent.toLowerCase()));
  }
}
