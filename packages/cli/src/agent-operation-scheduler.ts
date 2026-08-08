import { appLogger } from "./logging.js";

export type AgentOperationKind = "backfill" | "refresh";
export type AgentOperationResult = "committed" | "failed" | "skipped" | "unchanged";

interface AgentScheduleState {
  timer: NodeJS.Timeout | null;
  timerDeadline: number;
  isRefreshRunning: boolean;
  hasPendingRefresh: boolean;
  lastRefreshDurationMs: number;
  pendingSignalCount: number;
}

interface AgentOperationLifecycle {
  agentName: string;
  kind: AgentOperationKind;
  generation: number;
  startedAt: number;
}

export interface AgentOperationSchedulerSnapshot {
  activeOperations: number;
  activeRefreshes: number;
}

const PENDING_REFRESH_DELAY_MS = 100;
const MAX_ADAPTIVE_REFRESH_DELAY_MS = 30_000;
const ADAPTIVE_REFRESH_DELAY_MULTIPLIER = 4;

export class AgentOperationScheduler {
  private readonly states = new Map<string, AgentScheduleState>();
  private readonly operationGenerations = new Map<string, number>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private isStopped = false;

  constructor(private readonly runRefresh: (agentName: string) => Promise<AgentOperationResult>) {}

  notify(agentName: string, delayMs: number): void {
    if (this.isStopped) return;
    this.state(agentName).pendingSignalCount += 1;
    this.schedule(agentName, delayMs);
  }

  schedule(agentName: string, delayMs: number): void {
    if (this.isStopped) return;
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
      state.timerDeadline = 0;
      void this.refresh(agentName);
    }, effectiveDelayMs);
  }

  async refresh(agentName: string): Promise<void> {
    if (this.isStopped) return;
    const state = this.state(agentName);
    if (state.isRefreshRunning) {
      appLogger.debug("scan.refresh.pending", { agent: agentName });
      state.hasPendingRefresh = true;
      return;
    }

    state.isRefreshRunning = true;
    try {
      await this.run(agentName, "refresh", () => this.runRefresh(agentName));
    } finally {
      state.isRefreshRunning = false;
      if (state.hasPendingRefresh && !this.isStopped) {
        state.hasPendingRefresh = false;
        this.schedule(agentName, PENDING_REFRESH_DELAY_MS);
      }
    }
  }

  run<Result extends AgentOperationResult>(
    agentName: string,
    kind: AgentOperationKind,
    operation: () => Promise<Result>,
  ): Promise<Result | "skipped"> {
    const previous = this.operationTails.get(agentName) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (this.isStopped) return "skipped";
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

  takePendingSignalCount(agentName: string): number {
    const state = this.state(agentName);
    const count = state.pendingSignalCount;
    state.pendingSignalCount = 0;
    return count;
  }

  recordRefreshDuration(agentName: string, durationMs: number): void {
    this.state(agentName).lastRefreshDurationMs = durationMs;
  }

  snapshot(): AgentOperationSchedulerSnapshot {
    return {
      activeOperations: this.operationTails.size,
      activeRefreshes: [...this.states.values()].filter((state) => state.isRefreshRunning).length,
    };
  }

  stop(): void {
    this.isStopped = true;
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.timerDeadline = 0;
      state.hasPendingRefresh = false;
      state.pendingSignalCount = 0;
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.operationTails.values());
  }

  private state(agentName: string): AgentScheduleState {
    const existing = this.states.get(agentName);
    if (existing) return existing;
    const state: AgentScheduleState = {
      timer: null,
      timerDeadline: 0,
      isRefreshRunning: false,
      hasPendingRefresh: false,
      lastRefreshDurationMs: 0,
      pendingSignalCount: 0,
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
