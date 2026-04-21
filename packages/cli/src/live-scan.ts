import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
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
  depth?: number;
}

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

function closestWatchablePath(targetPath: string): string | null {
  if (!isAbsolute(targetPath) && !existsSync(targetPath)) {
    return null;
  }

  let current = targetPath;

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return current;
}

export function resolveAgentWatchTargets(agentName: string): WatchTarget[] {
  const roots = resolveProviderRoots();
  const cursorDataPath = getCursorDataPath();

  switch (agentName) {
    case "claudecode":
      return [
        { path: join(roots.claudeRoot, "projects"), depth: 2 },
        { path: "data/claudecode", depth: 2 },
      ];
    case "codex":
      return [{ path: join(roots.codexRoot, "sessions"), depth: 4 }];
    case "cursor":
      return cursorDataPath
        ? [
            { path: join(cursorDataPath, "globalStorage", "state.vscdb") },
            { path: join(cursorDataPath, "workspaceStorage"), depth: 2 },
          ]
        : [];
    case "kimi":
      return [
        { path: join(roots.kimiRoot, "sessions"), depth: 2 },
        { path: "data/kimi", depth: 2 },
      ];
    case "opencode":
      return [
        { path: join(roots.opencodeRoot, "opencode.db") },
        { path: "data/opencode/opencode.db" },
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
  private watchers: FSWatcher[] = [];

  constructor(
    private readonly watchEnabled = true,
    private readonly scanOptions: ScanOptions = {},
  ) {}

  async initialize(): Promise<void> {
    const initialResult = await scanSessions({
      ...this.scanOptions,
      useCache: true,
      smartRefresh: false,
    });
    const knownAgents = createRegisteredAgents();
    const agentMap = new Map<string, BaseAgent>();
    const allowedAgents = this.getAllowedAgents();

    for (const agent of initialResult.agents) {
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

    for (const agent of this.agents) {
      this.byAgent[agent.name] = sortSessions(initialResult.byAgent[agent.name] ?? []);
      this.refreshTimestamps.set(agent.name, Date.now());
    }

    this.rebuildSessions();
    if (this.watchEnabled) {
      this.startWatching();
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

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
  }

  private emit(event: SessionsUpdatedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private rebuildSessions(): void {
    this.sessions = sortSessions(Object.values(this.byAgent).flat());
  }

  private getAllowedAgents(): Set<string> | null {
    if (!this.scanOptions.agents?.length) {
      return null;
    }
    return new Set(this.scanOptions.agents.map((agent) => agent.toLowerCase()));
  }

  private applyFilters(sessions: SessionHead[]): SessionHead[] {
    return filterSessions(sessions, this.scanOptions);
  }

  private startWatching(): void {
    for (const agent of this.agents) {
      const rawTargets = resolveAgentWatchTargets(agent.name);
      const watchTargets = rawTargets
        .map((target) => {
          const watchPath = closestWatchablePath(target.path);
          return watchPath ? { ...target, path: watchPath } : null;
        })
        .filter((target): target is WatchTarget => target !== null)
        .filter(
          (target, index, items) =>
            items.findIndex((item) => item.path === target.path && item.depth === target.depth) ===
            index,
        );

      if (watchTargets.length === 0) {
        continue;
      }

      const watcher = chokidar.watch(
        watchTargets.map((target) => target.path),
        {
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 250,
            pollInterval: 100,
          },
          depth: watchTargets.reduce(
            (maxDepth, target) => Math.max(maxDepth, target.depth ?? 0),
            0,
          ),
        },
      );

      watcher.on("all", () => {
        this.scheduleRefresh(agent.name);
      });
      watcher.on("error", (error) => {
        console.error(`[${agent.name}] File watcher failed:`, error);
      });

      this.watchers.push(watcher);
    }
  }

  private scheduleRefresh(agentName: string, delayMs = 200): void {
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
      this.pendingRefreshes.add(agentName);
      return;
    }

    this.refreshInFlight.add(agentName);

    try {
      await this.runRefresh(agentName);
    } finally {
      this.refreshInFlight.delete(agentName);

      if (this.pendingRefreshes.delete(agentName)) {
        this.scheduleRefresh(agentName, 100);
      }
    }
  }

  private async runRefresh(agentName: string): Promise<void> {
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent) {
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
        return;
      }

      nextSessions = await Promise.resolve(
        agent.incrementalScan(previousSessions, checkResult.changedIds ?? []),
      );
    } else {
      nextSessions = await Promise.resolve(agent.scan());
      this.refreshTimestamps.set(agentName, Date.now());
    }

    nextSessions = this.applyFilters(nextSessions);
    saveCachedSessions(agentName, nextSessions, buildAgentCacheMeta(agent));
    syncSessionSearchIndex(agentName, nextSessions, (sessionId) => agent.getSessionData(sessionId));

    const event = buildUpdateEvent(agentName, previousSessions, nextSessions);
    this.byAgent[agentName] = sortSessions(nextSessions);
    this.rebuildSessions();

    if (event) {
      event.totalSessions = this.sessions.length;
      this.emit(event);
    }
  }
}
