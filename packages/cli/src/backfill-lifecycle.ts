import type { BackfillProgress, BackfillStatus } from "@codesesh/core/contract";

export type BackfillTerminalStatus = "committed" | "failed" | "skipped";

export interface BackfillAttemptRef {
  agentName: string;
  attemptId: number;
}

export type BackfillAttemptState =
  | (BackfillAttemptRef & { status: "queued" })
  | (BackfillAttemptRef & { status: "running"; progress?: BackfillProgress })
  | (BackfillAttemptRef & { status: BackfillTerminalStatus | "cancelled" });

export class BackfillLifecycle {
  private readonly attempts = new Map<string, BackfillAttemptState>();
  private nextAttemptId = 1;

  enqueue(agentName: string): BackfillAttemptRef | null {
    const current = this.attempts.get(agentName);
    if (current?.status === "queued" || current?.status === "running") return null;

    const attempt: BackfillAttemptState = {
      agentName,
      attemptId: this.nextAttemptId++,
      status: "queued",
    };
    this.attempts.set(agentName, attempt);
    return attempt;
  }

  startNext(): BackfillAttemptRef | null {
    if ([...this.attempts.values()].some((attempt) => attempt.status === "running")) return null;

    const queued = [...this.attempts.values()]
      .filter((attempt) => attempt.status === "queued")
      .sort((left, right) => left.attemptId - right.attemptId)[0];
    if (!queued) return null;

    const running: BackfillAttemptState = { ...queued, status: "running" };
    this.attempts.set(running.agentName, running);
    return running;
  }

  updateProgress(attempt: BackfillAttemptRef, progress: BackfillProgress): boolean {
    const current = this.matchingRunningAttempt(attempt);
    if (!current) return false;
    this.attempts.set(attempt.agentName, { ...current, progress: { ...progress } });
    return true;
  }

  complete(attempt: BackfillAttemptRef, status: BackfillTerminalStatus): boolean {
    if (!this.matchingRunningAttempt(attempt)) return false;
    this.attempts.set(attempt.agentName, { ...attempt, status });
    return true;
  }

  cancelAll(): void {
    for (const [agentName, attempt] of this.attempts) {
      if (attempt.status === "queued" || attempt.status === "running") {
        this.attempts.set(agentName, { ...attempt, status: "cancelled" });
      }
    }
  }

  runningAttempt(): BackfillAttemptRef | null {
    const running = [...this.attempts.values()].find((attempt) => attempt.status === "running");
    return running ?? null;
  }

  stateFor(agentName: string): BackfillAttemptState | undefined {
    const state = this.attempts.get(agentName);
    if (!state) return undefined;
    return state.status === "running" && state.progress
      ? { ...state, progress: { ...state.progress } }
      : { ...state };
  }

  status(): BackfillStatus {
    const states = [...this.attempts.values()];
    const queued = states
      .filter((attempt) => attempt.status === "queued")
      .sort((left, right) => left.attemptId - right.attemptId);
    const running = states.find((attempt) => attempt.status === "running");
    const status: BackfillStatus = {
      active: running != null || queued.length > 0,
      pendingAgents: queued.map((attempt) => attempt.agentName),
      completedAgents: states
        .filter((attempt) => attempt.status === "committed")
        .map((attempt) => attempt.agentName),
      failedAgents: states
        .filter((attempt) => attempt.status === "failed")
        .map((attempt) => attempt.agentName),
    };
    if (running) {
      status.currentAgent = running.agentName;
      if (running.progress) status.progress = { ...running.progress };
    }
    return status;
  }

  private matchingRunningAttempt(
    attempt: BackfillAttemptRef,
  ): Extract<BackfillAttemptState, { status: "running" }> | null {
    const current = this.attempts.get(attempt.agentName);
    return current?.status === "running" && current.attemptId === attempt.attemptId
      ? current
      : null;
  }
}
