import type { BackfillStatus } from "@codesesh/core/contract";

export interface BackfillWork {
  agentName: string;
  status: BackfillStatus;
}

export class BackfillCoordinator {
  private queue: string[] = [];
  private currentAgent: string | undefined;
  private completedAgents: string[] = [];

  get isRunning(): boolean {
    return this.currentAgent != null;
  }

  enqueue(agentName: string): BackfillStatus | null {
    if (this.currentAgent === agentName || this.queue.includes(agentName)) return null;
    this.queue.push(agentName);
    return this.snapshot();
  }

  take(): BackfillWork | null {
    if (this.currentAgent) return null;
    const agentName = this.queue.shift();
    if (!agentName) return null;

    this.currentAgent = agentName;
    return { agentName, status: this.snapshot() };
  }

  complete(agentName: string): BackfillStatus {
    if (this.currentAgent === agentName) this.currentAgent = undefined;
    if (!this.completedAgents.includes(agentName)) this.completedAgents.push(agentName);
    return this.snapshot();
  }

  clear(): void {
    this.queue.length = 0;
    this.currentAgent = undefined;
  }

  snapshot(): BackfillStatus {
    return {
      active: this.currentAgent != null || this.queue.length > 0,
      pendingAgents: [...this.queue],
      currentAgent: this.currentAgent,
      completedAgents: [...this.completedAgents],
    };
  }
}
