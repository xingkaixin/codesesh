import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  createRegisteredAgents,
  filterSessions,
  getCursorDataPath,
  resolveProviderRoots,
  scanSessions,
  syncSessionSearchIndex,
  saveCachedSessions,
  type BaseAgent,
  type ScanResult,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
} from "@codesesh/core";
import type { SearchIndexWorkerMessage } from "./search-index-worker.js";
import { appLogger, logSearchIndexSync } from "./logging.js";

export interface SessionsUpdatedEvent {
  type: "sessions-updated";
  changedAgents: string[];
  newSessions: number;
  updatedSessions: number;
  removedSessions: number;
  totalSessions: number;
  timestamp: number;
}

type StoreListener = (event: SessionsUpdatedEvent) => void;

interface WatchTarget {
  path: string;
  root?: string;
}

interface WatchScope {
  agentName: string;
  targetPath: string;
}

interface StablePathState {
  path: string;
  agentNames: Set<string>;
  lastMtimeMs: number | null;
  lastSize: number | null;
  stableSince: number;
  timer: NodeJS.Timeout | null;
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
const PENDING_REFRESH_DELAY_MS = 100;
const WRITE_STABILITY_THRESHOLD_MS = 250;
const WRITE_STABILITY_POLL_MS = 100;
const NEW_SESSION_EVENT_WINDOW_MS = 250;
const SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD = 100;

function sortSessions(sessions: SessionHead[]): SessionHead[] {
  return [...sessions].sort(
    (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
  );
}

function sessionSignature(session: SessionHead): string {
  return JSON.stringify([
    session.title,
    session.directory,
    session.time_created,
    session.time_updated ?? session.time_created,
    session.stats.message_count,
    session.stats.total_input_tokens,
    session.stats.total_output_tokens,
    session.stats.total_cost,
    session.stats.total_tokens ?? 0,
  ]);
}

function buildAgentCacheMeta(agent: BaseAgent): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap?.();
  const meta: Record<string, SessionCacheMeta> = {};
  if (!metaMap) return meta;

  for (const [id, data] of metaMap.entries()) {
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }

  return meta;
}

function buildUpdateEvent(
  agentName: string,
  previousSessions: SessionHead[],
  nextSessions: SessionHead[],
): SessionsUpdatedEvent | null {
  const previousMap = new Map(previousSessions.map((session) => [session.id, session]));
  const nextMap = new Map(nextSessions.map((session) => [session.id, session]));

  let newSessions = 0;
  let updatedSessions = 0;
  let removedSessions = 0;

  for (const [id, session] of nextMap.entries()) {
    const previous = previousMap.get(id);
    if (!previous) {
      newSessions += 1;
      continue;
    }
    if (sessionSignature(previous) !== sessionSignature(session)) {
      updatedSessions += 1;
    }
  }

  for (const id of previousMap.keys()) {
    if (!nextMap.has(id)) {
      removedSessions += 1;
    }
  }

  if (newSessions === 0 && updatedSessions === 0 && removedSessions === 0) {
    return null;
  }

  return {
    type: "sessions-updated",
    changedAgents: [agentName],
    newSessions,
    updatedSessions,
    removedSessions,
    totalSessions: nextSessions.length,
    timestamp: Date.now(),
  };
}

function toAbsolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function closestWatchablePath(targetPath: string): string | null {
  if (!isAbsolute(targetPath) && !existsSync(targetPath)) {
    return null;
  }

  let current = toAbsolutePath(targetPath);

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return current;
}

function getWatchRoot(path: string): string {
  const stat = statSync(path);
  return stat.isDirectory() ? path : dirname(path);
}

function isRecursiveWatchSupported(
  platform = process.platform,
  nodeVersion = process.versions.node,
): boolean {
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  if (platform !== "linux" && platform !== "aix" && platform !== "ibmi") {
    return false;
  }

  const [major = 0, minor = 0] = nodeVersion.split(".").map((part) => Number(part));
  return major > 19 || (major === 19 && minor >= 1);
}

function isRecursiveWatchUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
  );
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const path = relative(parentPath, childPath);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isRelatedPath(changedPath: string, targetPath: string): boolean {
  return isSameOrChildPath(targetPath, changedPath) || isSameOrChildPath(changedPath, targetPath);
}

function mergeEvents(
  previous: SessionsUpdatedEvent,
  next: SessionsUpdatedEvent,
): SessionsUpdatedEvent {
  return {
    type: "sessions-updated",
    changedAgents: Array.from(new Set([...previous.changedAgents, ...next.changedAgents])),
    newSessions: previous.newSessions + next.newSessions,
    updatedSessions: previous.updatedSessions + next.updatedSessions,
    removedSessions: previous.removedSessions + next.removedSessions,
    totalSessions: next.totalSessions,
    timestamp: next.timestamp,
  };
}

function mergeScopes(target: WatchScope[], scopes: WatchScope[]): void {
  for (const scope of scopes) {
    if (
      !target.some(
        (item) => item.agentName === scope.agentName && item.targetPath === scope.targetPath,
      )
    ) {
      target.push(scope);
    }
  }
}

function resolveWatchEventPath(watchPath: string, filename: string | Buffer | null): string {
  const filenameText = filename?.toString();
  if (!filenameText) {
    return watchPath;
  }
  return isAbsolute(filenameText) ? filenameText : join(watchPath, filenameText);
}

export function resolveAgentWatchTargets(agentName: string): WatchTarget[] {
  const roots = resolveProviderRoots();
  const cursorDataPath = getCursorDataPath();

  switch (agentName) {
    case "claudecode":
      return [
        { root: roots.claudeRoot, path: join(roots.claudeRoot, "projects") },
        { path: "data/claudecode" },
      ];
    case "codex":
      return [{ root: roots.codexRoot, path: join(roots.codexRoot, "sessions") }];
    case "cursor":
      return cursorDataPath
        ? [
            {
              root: cursorDataPath,
              path: join(cursorDataPath, "globalStorage", "state.vscdb"),
            },
            { root: cursorDataPath, path: join(cursorDataPath, "workspaceStorage") },
          ]
        : [];
    case "kimi":
      return [
        { root: roots.kimiRoot, path: join(roots.kimiRoot, "sessions") },
        { path: "data/kimi" },
      ];
    case "opencode":
      return [
        { root: roots.opencodeRoot, path: join(roots.opencodeRoot, "opencode.db") },
        { root: "data/opencode", path: "data/opencode/opencode.db" },
      ];
    default:
      return [];
  }
}

export class LiveScanStore {
  private agents: BaseAgent[] = [];
  private byAgent: Record<string, SessionHead[]> = {};
  private sessions: SessionHead[] = [];
  private listeners = new Set<StoreListener>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  private refreshTimestamps = new Map<string, number>();
  private refreshInFlight = new Set<string>();
  private pendingRefreshes = new Set<string>();
  private pendingRefreshPathCounts = new Map<string, number>();
  private watchers: FSWatcher[] = [];
  private fallbackWatchScopes = new Map<string, WatchScope[]>();
  private stablePaths = new Map<string, StablePathState>();
  private pendingEvent: SessionsUpdatedEvent | null = null;
  private pendingEventTimer: NodeJS.Timeout | null = null;
  private initialSearchIndexTimer: NodeJS.Timeout | null = null;
  private searchIndexWorker: Worker | null = null;

  constructor(
    private readonly watchEnabled = true,
    private readonly scanOptions: ScanOptions = {},
    private readonly startupScanOptions: Pick<ScanOptions, "from" | "to"> = {},
  ) {}

  async initialize(): Promise<void> {
    const startedAt = performance.now();
    appLogger.info("scan.initial.start", {
      watch_enabled: this.watchEnabled,
      agents: this.scanOptions.agents,
      use_cache: this.scanOptions.useCache ?? true,
      startup_from: this.startupScanOptions.from,
      startup_to: this.startupScanOptions.to,
    });
    const initialResult = await scanSessions({
      ...this.scanOptions,
      ...this.startupScanOptions,
      useCache: this.scanOptions.useCache ?? true,
      smartRefresh: false,
      writeCache:
        this.startupScanOptions.from != null || this.startupScanOptions.to != null
          ? false
          : undefined,
      includeSmartTags:
        this.startupScanOptions.from != null || this.startupScanOptions.to != null
          ? false
          : undefined,
    });
    this.applyScanResult(initialResult);
    appLogger.info("scan.initial.done", {
      duration_ms: Math.round(performance.now() - startedAt),
      sessions: this.sessions.length,
      agents: Object.fromEntries(
        Object.entries(this.byAgent).map(([key, value]) => [key, value.length]),
      ),
    });
    if (this.watchEnabled) {
      this.startWatching();
      this.initialSearchIndexTimer = setTimeout(() => {
        this.initialSearchIndexTimer = null;
        this.startSearchIndexWorker("scan.initial.background");
      }, 1000);
    }
  }

  getSnapshot(): ScanResult {
    return {
      sessions: this.sessions,
      byAgent: this.byAgent,
      agents: this.agents,
    };
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async shutdown(): Promise<void> {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.pendingRefreshPathCounts.clear();

    for (const state of this.stablePaths.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.stablePaths.clear();

    if (this.pendingEventTimer) {
      clearTimeout(this.pendingEventTimer);
      this.pendingEventTimer = null;
    }
    if (this.initialSearchIndexTimer) {
      clearTimeout(this.initialSearchIndexTimer);
      this.initialSearchIndexTimer = null;
    }
    if (this.searchIndexWorker) {
      await this.searchIndexWorker.terminate();
      this.searchIndexWorker = null;
    }
    this.pendingEvent = null;

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
    this.fallbackWatchScopes.clear();
  }

  private emit(event: SessionsUpdatedEvent): void {
    if (this.pendingEvent || event.newSessions > 0) {
      this.queueEvent(event);
      return;
    }

    this.emitNow(event);
  }

  private emitNow(event: SessionsUpdatedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private queueEvent(event: SessionsUpdatedEvent): void {
    this.pendingEvent = this.pendingEvent ? mergeEvents(this.pendingEvent, event) : event;
    if (this.pendingEventTimer) {
      return;
    }

    this.pendingEventTimer = setTimeout(() => {
      const pending = this.pendingEvent;
      this.pendingEvent = null;
      this.pendingEventTimer = null;
      if (pending) {
        this.emitNow(pending);
      }
    }, NEW_SESSION_EVENT_WINDOW_MS);
  }

  private rebuildSessions(): void {
    this.sessions = sortSessions(Object.values(this.byAgent).flat());
  }

  private hasStartupWindow(): boolean {
    return this.startupScanOptions.from != null || this.startupScanOptions.to != null;
  }

  private getSearchIndexWorkerUrl(): URL | null {
    const workerUrl = new URL("./search-index-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) {
      return null;
    }
    return workerUrl;
  }

  private startSearchIndexWorker(context: string): void {
    if (this.searchIndexWorker) return;

    const workerUrl = this.getSearchIndexWorkerUrl();
    if (!workerUrl) {
      appLogger.warn("search_index.worker_missing", { context });
      return;
    }

    const worker = new Worker(workerUrl, {
      workerData: {
        context,
        agentNames: this.agents.map((agent) => agent.name),
        sessionsByAgent: this.byAgent,
        metaByAgent: Object.fromEntries(
          this.agents.map((agent) => [agent.name, buildAgentCacheMeta(agent)]),
        ),
      },
    });
    worker.unref();
    this.searchIndexWorker = worker;

    worker.on("message", (message: SearchIndexWorkerMessage) => {
      if (message.type === "sync-result") {
        logSearchIndexSync(message.context, message.result);
      } else if (message.type === "done") {
        appLogger.info(`${message.context}.done`, {
          duration_ms: Math.round(message.durationMs),
          sessions: message.sessions,
        });
      }
    });
    worker.on("error", (error) => {
      appLogger.error("search_index.worker_error", { context, error });
    });
    worker.on("exit", (code) => {
      this.searchIndexWorker = null;
      if (code !== 0) {
        appLogger.warn("search_index.worker_exit", { context, code });
      }
    });
  }

  private applyScanResult(result: ScanResult): void {
    const knownAgents = createRegisteredAgents();
    const agentMap = new Map<string, BaseAgent>();
    const allowedAgents = this.getAllowedAgents();

    for (const agent of result.agents) {
      agentMap.set(agent.name, agent);
    }
    for (const agent of knownAgents) {
      if (!agentMap.has(agent.name)) {
        agentMap.set(agent.name, agent);
      }
    }

    this.agents = [...agentMap.values()].filter((agent) => {
      if (!allowedAgents) {
        return true;
      }
      return allowedAgents.has(agent.name.toLowerCase());
    });

    this.byAgent = {};
    for (const agent of this.agents) {
      this.byAgent[agent.name] = sortSessions(result.byAgent[agent.name] ?? []);
      this.refreshTimestamps.set(agent.name, Date.now());
    }

    this.rebuildSessions();
  }

  private getAllowedAgents(): Set<string> | null {
    if (!this.scanOptions.agents?.length) {
      return null;
    }
    return new Set(this.scanOptions.agents.map((agent) => agent.toLowerCase()));
  }

  private applyFilters(sessions: SessionHead[]): SessionHead[] {
    return filterSessions(sessions, { ...this.scanOptions, ...this.startupScanOptions });
  }

  private startWatching(): void {
    const scopesByRoot = new Map<string, WatchScope[]>();

    for (const agent of this.agents) {
      const watchTargets = resolveAgentWatchTargets(agent.name);

      if (watchTargets.length === 0) {
        appLogger.debug("watch.skip", { agent: agent.name });
        continue;
      }

      for (const target of watchTargets) {
        const watchRootPath = closestWatchablePath(target.root ?? target.path);
        if (!watchRootPath) continue;

        let rootPath: string;
        try {
          rootPath = getWatchRoot(watchRootPath);
        } catch (error) {
          this.reportWatchError("watch.resolve.error", { path: watchRootPath, error });
          continue;
        }
        const targetPath = toAbsolutePath(target.path);
        const scopes = scopesByRoot.get(rootPath) ?? [];
        if (
          !scopes.some((scope) => scope.agentName === agent.name && scope.targetPath === targetPath)
        ) {
          scopes.push({ agentName: agent.name, targetPath });
        }
        scopesByRoot.set(rootPath, scopes);
      }
    }

    for (const [rootPath, scopes] of scopesByRoot.entries()) {
      const agents = Array.from(new Set(scopes.map((scope) => scope.agentName)));
      appLogger.info("watch.start", {
        root: rootPath,
        agents,
        targets: scopes.map((scope) => ({
          agent: scope.agentName,
          path: scope.targetPath,
        })),
      });

      if (isRecursiveWatchSupported()) {
        const started = this.watchDirectory(rootPath, scopes, true);
        if (started) {
          continue;
        }
      }

      this.watchDirectoryTree(rootPath, scopes);
    }
  }

  private watchDirectory(path: string, scopes: WatchScope[], recursive: boolean): boolean {
    try {
      const watcher = watch(path, { recursive }, (eventType, filename) => {
        queueMicrotask(() => {
          try {
            const activeScopes = recursive
              ? scopes
              : (this.fallbackWatchScopes.get(path) ?? scopes);
            this.handleWatchEvent(path, activeScopes, eventType, filename);
            if (!recursive) {
              this.watchNewDirectories(path, filename, activeScopes);
            }
          } catch (error) {
            this.reportWatchError("watch.event.error", { path, recursive, error });
          }
        });
      });

      watcher.on("error", (error) => {
        this.reportWatchError("watch.error", { path, recursive, error });
      });

      this.watchers.push(watcher);
      return true;
    } catch (error) {
      if (recursive && isRecursiveWatchUnavailable(error)) {
        appLogger.warn("watch.recursive_unavailable", { path, error });
        return false;
      }

      this.reportWatchError("watch.start.error", { path, recursive, error });
      return false;
    }
  }

  private watchDirectoryTree(rootPath: string, scopes: WatchScope[]): void {
    const pending = [rootPath];

    while (pending.length > 0) {
      const dirPath = pending.pop()!;
      this.watchFallbackDirectory(dirPath, scopes);

      try {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            pending.push(join(dirPath, entry.name));
          }
        }
      } catch (error) {
        this.reportWatchError("watch.scan.error", { path: dirPath, error });
      }
    }
  }

  private watchFallbackDirectory(path: string, scopes: WatchScope[]): void {
    const existingScopes = this.fallbackWatchScopes.get(path);
    if (existingScopes) {
      mergeScopes(existingScopes, scopes);
      return;
    }

    const storedScopes = [...scopes];
    this.fallbackWatchScopes.set(path, storedScopes);
    if (!this.watchDirectory(path, storedScopes, false)) {
      this.fallbackWatchScopes.delete(path);
    }
  }

  private watchNewDirectories(
    watchPath: string,
    filename: string | Buffer | null,
    scopes: WatchScope[],
  ): void {
    const path = resolveWatchEventPath(watchPath, filename);
    try {
      if (statSync(path).isDirectory()) {
        this.watchDirectoryTree(path, scopes);
      }
    } catch {}
  }

  private handleWatchEvent(
    watchPath: string,
    scopes: WatchScope[],
    eventType: string,
    filename: string | Buffer | null,
  ): void {
    const changedPath = resolveWatchEventPath(watchPath, filename);
    const agentNames = new Set(
      scopes
        .filter((scope) => isRelatedPath(changedPath, scope.targetPath))
        .map((scope) => scope.agentName),
    );

    if (agentNames.size === 0) {
      return;
    }

    appLogger.debug("watch.event", {
      event: eventType,
      path: changedPath,
      agents: Array.from(agentNames),
    });
    this.waitForStablePath(changedPath, agentNames);
  }

  private waitForStablePath(path: string, agentNames: Set<string>): void {
    const existing = this.stablePaths.get(path);
    if (existing) {
      for (const agentName of agentNames) {
        existing.agentNames.add(agentName);
      }
      return;
    }

    const state: StablePathState = {
      path,
      agentNames: new Set(agentNames),
      lastMtimeMs: null,
      lastSize: null,
      stableSince: Date.now(),
      timer: null,
    };
    this.stablePaths.set(path, state);
    this.pollStablePath(path);
  }

  private pollStablePath(path: string): void {
    const state = this.stablePaths.get(path);
    if (!state) {
      return;
    }

    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      this.stablePaths.delete(path);
      this.scheduleRefreshForAgents(state.agentNames);
      return;
    }

    const now = Date.now();
    const unchanged = state.lastSize === size && state.lastMtimeMs === mtimeMs;
    if (!unchanged) {
      state.lastSize = size;
      state.lastMtimeMs = mtimeMs;
      state.stableSince = now;
    }

    if (unchanged && now - state.stableSince >= WRITE_STABILITY_THRESHOLD_MS) {
      this.stablePaths.delete(path);
      this.scheduleRefreshForAgents(state.agentNames);
      return;
    }

    state.timer = setTimeout(() => this.pollStablePath(path), WRITE_STABILITY_POLL_MS);
  }

  private scheduleRefreshForAgents(agentNames: Set<string>): void {
    for (const agentName of agentNames) {
      this.pendingRefreshPathCounts.set(
        agentName,
        (this.pendingRefreshPathCounts.get(agentName) ?? 0) + 1,
      );
      const delayMs =
        (this.byAgent[agentName]?.length ?? 0) === 0
          ? EMPTY_AGENT_REFRESH_DEBOUNCE_MS
          : REFRESH_DEBOUNCE_MS;
      this.scheduleRefresh(agentName, delayMs);
    }
  }

  private reportWatchError(event: string, data: Record<string, unknown>): void {
    appLogger.error(event, data);
    console.error("[watch] File watcher failed:", data.error);
  }

  private scheduleRefresh(agentName: string, delayMs = REFRESH_DEBOUNCE_MS): void {
    appLogger.debug("scan.refresh.schedule", { agent: agentName, delay_ms: delayMs });
    const existing = this.refreshTimers.get(agentName);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.refreshTimers.delete(agentName);
      void this.refreshAgent(agentName);
    }, delayMs);

    this.refreshTimers.set(agentName, timer);
  }

  private async refreshAgent(agentName: string): Promise<void> {
    if (this.refreshInFlight.has(agentName)) {
      appLogger.debug("scan.refresh.pending", { agent: agentName });
      this.pendingRefreshes.add(agentName);
      return;
    }

    this.refreshInFlight.add(agentName);

    try {
      await this.runRefresh(agentName);
    } catch (error) {
      appLogger.error("scan.refresh.error", { agent: agentName, error });
      console.error(`[${agentName}] Session refresh failed:`, error);
    } finally {
      this.refreshInFlight.delete(agentName);

      if (this.pendingRefreshes.delete(agentName)) {
        this.scheduleRefresh(agentName, PENDING_REFRESH_DELAY_MS);
      }
    }
  }

  private async runRefresh(agentName: string): Promise<void> {
    const startedAt = performance.now();
    const pendingPathCount = this.pendingRefreshPathCounts.get(agentName) ?? 0;
    this.pendingRefreshPathCounts.delete(agentName);
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return;
    }

    const previousSessions = this.byAgent[agentName] ?? [];
    let nextSessions = previousSessions;

    if (!agent.isAvailable()) {
      nextSessions = [];
      this.refreshTimestamps.set(agentName, Date.now());
    } else if (previousSessions.length > 0 && agent.checkForChanges && agent.incrementalScan) {
      const checkResult = await Promise.resolve(
        agent.checkForChanges(this.refreshTimestamps.get(agentName) ?? 0, previousSessions),
      );

      this.refreshTimestamps.set(agentName, checkResult.timestamp);
      if (!checkResult.hasChanges) {
        appLogger.debug("scan.refresh.unchanged", {
          agent: agentName,
          duration_ms: Math.round(performance.now() - startedAt),
        });
        return;
      }

      nextSessions = await Promise.resolve(
        agent.incrementalScan(previousSessions, checkResult.changedIds ?? []),
      );
    } else {
      nextSessions = await Promise.resolve(agent.scan(this.startupScanOptions));
      this.refreshTimestamps.set(agentName, Date.now());
    }

    nextSessions = this.applyFilters(nextSessions);
    if (!this.hasStartupWindow()) {
      saveCachedSessions(agentName, nextSessions, buildAgentCacheMeta(agent));
    }
    const searchIndexOptions =
      pendingPathCount >= SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD ? { isBulk: true } : undefined;
    const syncResult = searchIndexOptions
      ? syncSessionSearchIndex(
          agentName,
          nextSessions,
          (sessionId) => agent.getSessionData(sessionId),
          searchIndexOptions,
        )
      : syncSessionSearchIndex(agentName, nextSessions, (sessionId) =>
          agent.getSessionData(sessionId),
        );
    logSearchIndexSync("scan.refresh", syncResult, { pending_paths: pendingPathCount });

    const event = buildUpdateEvent(agentName, previousSessions, nextSessions);
    this.byAgent[agentName] = sortSessions(nextSessions);
    this.rebuildSessions();

    if (event) {
      event.totalSessions = this.sessions.length;
      this.emit(event);
    }
    appLogger.info("scan.refresh.done", {
      agent: agentName,
      duration_ms: Math.round(performance.now() - startedAt),
      sessions: nextSessions.length,
      new_sessions: event?.newSessions ?? 0,
      updated_sessions: event?.updatedSessions ?? 0,
      removed_sessions: event?.removedSessions ?? 0,
      pending_paths: pendingPathCount,
      search_index_mode: syncResult?.mode,
      search_index_rebuild_duration_ms:
        syncResult?.rebuildDurationMs == null
          ? undefined
          : Math.round(syncResult.rebuildDurationMs),
    });
  }
}
