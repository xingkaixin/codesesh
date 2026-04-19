import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  createRegisteredAgents,
  getCursorDataPath,
  resolveProviderRoots,
  scanSessions,
  type BaseAgent,
  type ScanResult,
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

function closestWatchablePath(targetPath: string): string {
  let current = targetPath;

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return current;
}

function resolveAgentWatchPaths(agentName: string): string[] {
  const roots = resolveProviderRoots();
  const cursorDataPath = getCursorDataPath();

  switch (agentName) {
    case "claudecode":
      return [join(roots.claudeRoot, "projects"), "data/claudecode"];
    case "codex":
      return [join(roots.codexRoot, "sessions")];
    case "cursor":
      return cursorDataPath
        ? [
            join(cursorDataPath, "globalStorage", "state.vscdb"),
            join(cursorDataPath, "workspaceStorage"),
          ]
        : [];
    case "kimi":
      return [join(roots.kimiRoot, "sessions"), "data/kimi"];
    case "opencode":
      return [join(roots.opencodeRoot, "opencode.db"), "data/opencode/opencode.db"];
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

  constructor(private readonly watchEnabled = true) {}

  async initialize(): Promise<void> {
    const initialResult = await scanSessions({
      useCache: true,
      smartRefresh: false,
    });
    const knownAgents = createRegisteredAgents();
    const agentMap = new Map<string, BaseAgent>();

    for (const agent of initialResult.agents) {
      agentMap.set(agent.name, agent);
    }
    for (const agent of knownAgents) {
      if (!agentMap.has(agent.name)) {
        agentMap.set(agent.name, agent);
      }
    }

    this.agents = [...agentMap.values()];

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

  private startWatching(): void {
    for (const agent of this.agents) {
      const rawPaths = resolveAgentWatchPaths(agent.name);
      const watchPaths = [...new Set(rawPaths.map(closestWatchablePath))];

      if (watchPaths.length === 0) {
        continue;
      }

      const watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 250,
          pollInterval: 100,
        },
      });

      watcher.on("all", () => {
        this.scheduleRefresh(agent.name);
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

    const event = buildUpdateEvent(agentName, previousSessions, nextSessions);
    this.byAgent[agentName] = sortSessions(nextSessions);
    this.rebuildSessions();

    if (event) {
      event.totalSessions = this.sessions.length;
      this.emit(event);
    }
  }
}
