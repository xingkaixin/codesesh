import type { AgentScanProgress } from "@codesesh/core";
import type { BackfillStatus, ScanStatusEvent } from "@codesesh/core/contract";

type ScanStatus = Omit<ScanStatusEvent, "type">;

export class ScanStatusModel {
  private status: ScanStatus = {
    active: false,
    phase: "idle",
    pendingAgents: [],
    scanningAgents: [],
    completedAgents: [],
    agentStatuses: {},
    totalAgents: 0,
    updatedAt: Date.now(),
    backfill: { active: false, pendingAgents: [], completedAgents: [] },
  };

  snapshot(): ScanStatusEvent {
    return {
      type: "scan-status",
      ...this.status,
      pendingAgents: [...this.status.pendingAgents],
      scanningAgents: [...this.status.scanningAgents],
      completedAgents: [...this.status.completedAgents],
      agentStatuses: Object.fromEntries(
        Object.entries(this.status.agentStatuses).map(([agentName, status]) => [
          agentName,
          { ...status },
        ]),
      ),
      backfill: {
        ...this.status.backfill,
        pendingAgents: [...this.status.backfill.pendingAgents],
        completedAgents: [...this.status.backfill.completedAgents],
      },
    };
  }

  startBatch(
    agentNames: string[],
    phase: ScanStatusEvent["phase"],
    sessionCounts: Record<string, number>,
  ): ScanStatusEvent {
    const uniqueAgentNames = [...new Set(agentNames)];
    const now = Date.now();
    const agentStatuses = Object.fromEntries(
      uniqueAgentNames.map((agentName) => [
        agentName,
        {
          agentName,
          status: "pending" as const,
          processed: 0,
          sessions: sessionCounts[agentName] ?? 0,
          updatedAt: now,
        },
      ]),
    );
    return this.set({
      ...this.status,
      active: uniqueAgentNames.length > 0,
      phase: uniqueAgentNames.length > 0 ? phase : "idle",
      pendingAgents: uniqueAgentNames,
      scanningAgents: [],
      completedAgents: [],
      agentStatuses,
      totalAgents: uniqueAgentNames.length,
      startedAt: uniqueAgentNames.length > 0 ? now : undefined,
      updatedAt: now,
      completedAt: uniqueAgentNames.length > 0 ? undefined : now,
    });
  }

  setPhase(phase: ScanStatusEvent["phase"]): ScanStatusEvent | null {
    if (!this.status.active) return null;
    return this.set({ ...this.status, phase, updatedAt: Date.now() });
  }

  beginAgent(agentName: string, sessionCount: number): ScanStatusEvent {
    if (!this.status.active)
      this.startBatch([agentName], "scanning", { [agentName]: sessionCount });

    const pendingAgents = this.status.pendingAgents.filter((agent) => agent !== agentName);
    const scanningAgents = [...new Set([...this.status.scanningAgents, agentName])];
    const completedAgents = this.status.completedAgents.filter((agent) => agent !== agentName);
    const existingStatus = this.status.agentStatuses[agentName];
    const now = Date.now();
    return this.set({
      ...this.status,
      active: true,
      phase: this.status.phase === "initializing" ? "initializing" : "scanning",
      pendingAgents,
      scanningAgents,
      completedAgents,
      agentStatuses: {
        ...this.status.agentStatuses,
        [agentName]: {
          agentName,
          status: "scanning",
          total: existingStatus?.total,
          processed: existingStatus?.processed ?? 0,
          sessions: existingStatus?.sessions ?? sessionCount,
          startedAt: existingStatus?.startedAt ?? now,
          updatedAt: now,
        },
      },
      totalAgents: Math.max(this.status.totalAgents, pendingAgents.length + scanningAgents.length),
      updatedAt: now,
      completedAt: undefined,
    });
  }

  updateAgent(agentName: string, progress: AgentScanProgress): ScanStatusEvent | null {
    const status = this.status.agentStatuses[agentName];
    if (!status || status.status !== "scanning") return null;
    const now = Date.now();
    return this.set({
      ...this.status,
      agentStatuses: {
        ...this.status.agentStatuses,
        [agentName]: {
          ...status,
          total: progress.total ?? status.total,
          processed: progress.processed ?? status.processed,
          sessions: progress.sessions ?? status.sessions,
          updatedAt: now,
        },
      },
      updatedAt: now,
    });
  }

  finishAgent(agentName: string, sessionCount?: number): ScanStatusEvent {
    const pendingAgents = this.status.pendingAgents.filter((agent) => agent !== agentName);
    const scanningAgents = this.status.scanningAgents.filter((agent) => agent !== agentName);
    const completedAgents = [...new Set([...this.status.completedAgents, agentName])];
    const isActive = pendingAgents.length > 0 || scanningAgents.length > 0;
    const now = Date.now();
    const previousStatus = this.status.agentStatuses[agentName];
    const total = previousStatus?.total ?? previousStatus?.processed;

    return this.set({
      ...this.status,
      active: isActive,
      phase: isActive ? "scanning" : "idle",
      pendingAgents,
      scanningAgents,
      completedAgents,
      agentStatuses: {
        ...this.status.agentStatuses,
        [agentName]: {
          agentName,
          status: "complete",
          total,
          processed: total,
          sessions: sessionCount ?? previousStatus?.sessions ?? 0,
          startedAt: previousStatus?.startedAt,
          updatedAt: now,
          completedAt: now,
        },
      },
      updatedAt: now,
      completedAt: isActive ? undefined : now,
    });
  }

  finishBatch(): ScanStatusEvent {
    const now = Date.now();
    return this.set({
      ...this.status,
      active: false,
      phase: "idle",
      pendingAgents: [],
      scanningAgents: [],
      agentStatuses: Object.fromEntries(
        Object.entries(this.status.agentStatuses).map(([agentName, status]) => [
          agentName,
          { ...status, status: "complete", completedAt: status.completedAt ?? now, updatedAt: now },
        ]),
      ),
      updatedAt: now,
      completedAt: now,
    });
  }

  updateBackfill(patch: Partial<BackfillStatus>): ScanStatusEvent {
    return this.set({
      ...this.status,
      backfill: { ...this.status.backfill, ...patch },
      updatedAt: Date.now(),
    });
  }

  private set(status: ScanStatus): ScanStatusEvent {
    this.status = status;
    return this.snapshot();
  }
}
