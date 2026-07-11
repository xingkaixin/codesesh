import { appLogger } from "./logging.js";

export type AgentOperationKind = "backfill" | "refresh";
export type AgentOperationResult = "committed" | "failed" | "skipped" | "unchanged";

interface AgentRefreshState {
  timer: NodeJS.Timeout | null;
  timerDeadline: number;
  isRunning: boolean;
  hasPendingRerun: boolean;
  lastRefreshAt: number;
  lastRefreshDurationMs: number;
  pendingPathCount: number;
}

interface AgentOperationLifecycle {
  agentName: string;
  kind: AgentOperationKind;
  generation: number;
  startedAt: number;
}

const PENDING_REFRESH_DELAY_MS = 100;
const MAX_ADAPTIVE_REFRESH_DELAY_MS = 30_000;
const ADAPTIVE_REFRESH_DELAY_MULTIPLIER = 4;

export class RefreshCoordinator {
  private states = new Map<string, AgentRefreshState>();
  private operationGenerations = new Map<string, number>();
  private operationTails = new Map<string, Promise<void>>();
  private isShuttingDown = false;

  get activeOperationCount(): number {
    return this.operationTails.size;
  }

  get activeRefreshCount(): number {
    return [...this.states.values()].filter((state) => state.isRunning).length;
  }

  recordChangedPaths(agentName: string, count = 1): void {
    this.state(agentName).pendingPathCount += count;
  }

  takePendingPathCount(agentName: string): number {
    const state = this.state(agentName);
    const count = state.pendingPathCount;
    state.pendingPathCount = 0;
    return count;
  }

  lastRefreshAt(agentName: string): number {
    return this.state(agentName).lastRefreshAt;
  }

  setLastRefreshAt(agentName: string, timestamp: number): void {
    this.state(agentName).lastRefreshAt = timestamp;
  }

  setLastRefreshDuration(agentName: string, durationMs: number): void {
    this.state(agentName).lastRefreshDurationMs = durationMs;
  }

  schedule(agentName: string, delayMs: number, refresh: () => Promise<void>): void {
    if (this.isShuttingDown) return;
    const state = this.state(agentName);
    const adaptiveDelayMs = Math.min(
      state.lastRefreshDurationMs * ADAPTIVE_REFRESH_DELAY_MULTIPLIER,
      MAX_ADAPTIVE_REFRESH_DELAY_MS,
    );
    const effectiveDelayMs = Math.max(delayMs, adaptiveDelayMs);
    const deadline = Date.now() + effectiveDelayMs;

    if (state.timer) {
      if (deadline >= state.timerDeadline) return;
      clearTimeout(state.timer);
    }

    appLogger.debug("scan.refresh.schedule", { agent: agentName, delay_ms: effectiveDelayMs });
    state.timerDeadline = deadline;
    state.timer = setTimeout(() => {
      state.timer = null;
      void refresh();
    }, effectiveDelayMs);
  }

  async runRefresh(
    agentName: string,
    operation: () => Promise<AgentOperationResult>,
  ): Promise<void> {
    const state = this.state(agentName);
    if (state.isRunning) {
      appLogger.debug("scan.refresh.pending", { agent: agentName });
      state.hasPendingRerun = true;
      return;
    }

    state.isRunning = true;
    try {
      await this.serialize(agentName, "refresh", operation);
    } finally {
      state.isRunning = false;
      if (state.hasPendingRerun && !this.isShuttingDown) {
        state.hasPendingRerun = false;
        this.schedule(agentName, PENDING_REFRESH_DELAY_MS, () =>
          this.runRefresh(agentName, operation),
        );
      }
    }
  }

  serialize(
    agentName: string,
    kind: AgentOperationKind,
    operation: () => Promise<AgentOperationResult>,
  ): Promise<AgentOperationResult> {
    const previous = this.operationTails.get(agentName) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (this.isShuttingDown) return "skipped";
      const lifecycle = this.beginOperation(agentName, kind);
      try {
        const result = await operation();
        this.completeOperation(lifecycle, result);
        return result;
      } catch (error) {
        this.completeOperation(lifecycle, "failed");
        throw error;
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(agentName, tail);
    void tail.finally(() => {
      if (this.operationTails.get(agentName) === tail) this.operationTails.delete(agentName);
    });
    return run;
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    for (const state of this.states.values()) {
      if (!state.timer) continue;
      clearTimeout(state.timer);
      state.timer = null;
      state.timerDeadline = 0;
    }
    await Promise.allSettled(this.operationTails.values());
  }

  private state(agentName: string): AgentRefreshState {
    const existing = this.states.get(agentName);
    if (existing) return existing;
    const state: AgentRefreshState = {
      timer: null,
      timerDeadline: 0,
      isRunning: false,
      hasPendingRerun: false,
      lastRefreshAt: 0,
      lastRefreshDurationMs: 0,
      pendingPathCount: 0,
    };
    this.states.set(agentName, state);
    return state;
  }

  private beginOperation(agentName: string, kind: AgentOperationKind): AgentOperationLifecycle {
    const generation = (this.operationGenerations.get(agentName) ?? 0) + 1;
    const startedAt = Date.now();
    this.operationGenerations.set(agentName, generation);
    appLogger.info("scan.agent_operation.started", {
      agent: agentName,
      operation: kind,
      generation,
      started_at: startedAt,
    });
    return { agentName, kind, generation, startedAt };
  }

  private completeOperation(
    lifecycle: AgentOperationLifecycle,
    result: AgentOperationResult,
  ): void {
    const completedAt = Date.now();
    appLogger.info("scan.agent_operation.completed", {
      agent: lifecycle.agentName,
      operation: lifecycle.kind,
      generation: lifecycle.generation,
      started_at: lifecycle.startedAt,
      completed_at: completedAt,
      duration_ms: completedAt - lifecycle.startedAt,
      result,
    });
  }
}
