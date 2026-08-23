import type { AgentScanProgress } from "@codesesh/core/runtime";
import type {
  BackfillStatus,
  ScanCompletion,
  ScanStatusEvent,
  SearchIndexMaintenanceStatus,
} from "@codesesh/core/contract";

type ScanStatus = Omit<
  ScanStatusEvent,
  | "type"
  | "active"
  | "pendingAgents"
  | "scanningAgents"
  | "completedAgents"
  | "totalAgents"
  | "searchIndexMaintenance"
> & {
  searchIndexMaintenance: SearchIndexMaintenanceStatus;
};

interface AgentLists {
  pendingAgents: string[];
  scanningAgents: string[];
  completedAgents: string[];
}

export class ScanStatusModel {
  private status: ScanStatus = {
    phase: "idle",
    agentStatuses: {},
    updatedAt: Date.now(),
    backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
    searchIndexMaintenance: {
      active: false,
      pendingAgents: [],
      completedAgents: [],
      failedAgents: [],
    },
  };

  snapshot(): ScanStatusEvent {
    const agentLists = this.agentLists(this.status.agentStatuses);
    const active = this.hasActiveAgents(this.status.agentStatuses);
    const backfill = {
      ...this.status.backfill,
      pendingAgents: [...this.status.backfill.pendingAgents],
      completedAgents: [...this.status.backfill.completedAgents],
      failedAgents: [...this.status.backfill.failedAgents],
    };
    if (this.status.backfill.progress) {
      backfill.progress = { ...this.status.backfill.progress };
    } else {
      delete backfill.progress;
    }
    if (this.status.backfill.partialAgents) {
      backfill.partialAgents = Object.fromEntries(
        Object.entries(this.status.backfill.partialAgents).map(([agentName, completion]) => [
          agentName,
          { ...completion },
        ]),
      );
    } else {
      delete backfill.partialAgents;
    }
    return {
      type: "scan-status",
      ...this.status,
      active,
      ...agentLists,
      totalAgents: Object.keys(this.status.agentStatuses).length,
      agentStatuses: Object.fromEntries(
        Object.entries(this.status.agentStatuses).map(([agentName, status]) => [
          agentName,
          { ...status },
        ]),
      ),
      backfill,
      searchIndexMaintenance: {
        ...this.status.searchIndexMaintenance,
        pendingAgents: [...this.status.searchIndexMaintenance.pendingAgents],
        completedAgents: [...this.status.searchIndexMaintenance.completedAgents],
        failedAgents: [...this.status.searchIndexMaintenance.failedAgents],
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
      phase: uniqueAgentNames.length > 0 ? phase : "idle",
      agentStatuses,
      startedAt: uniqueAgentNames.length > 0 ? now : undefined,
      updatedAt: now,
      completedAt: uniqueAgentNames.length > 0 ? undefined : now,
    });
  }

  setPhase(phase: ScanStatusEvent["phase"]): ScanStatusEvent | null {
    if (!this.hasActiveAgents(this.status.agentStatuses)) return null;
    return this.set({ ...this.status, phase, updatedAt: Date.now() });
  }

  beginAgent(agentName: string, sessionCount: number): ScanStatusEvent {
    if (!this.hasActiveAgents(this.status.agentStatuses)) {
      this.startBatch([agentName], "scanning", { [agentName]: sessionCount });
    }

    const existingStatus = this.status.agentStatuses[agentName];
    const now = Date.now();
    return this.set({
      ...this.status,
      phase: this.status.phase === "initializing" ? "initializing" : "scanning",
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
      updatedAt: now,
      completedAt: undefined,
    });
  }

  updateAgent(agentName: string, progress: AgentScanProgress): ScanStatusEvent | null {
    const status = this.status.agentStatuses[agentName];
    if (
      !status ||
      status.status === "pending" ||
      status.status === "complete" ||
      ((status.status === "publish-queued" || status.status === "publishing") &&
        progress.phase !== "finalizing")
    ) {
      return null;
    }
    const now = Date.now();
    const nextStatus: "finalizing" | "scanning" =
      progress.phase === "finalizing" ? "finalizing" : "scanning";
    const agentStatuses = {
      ...this.status.agentStatuses,
      [agentName]: {
        ...status,
        status: nextStatus,
        total: progress.total ?? status.total,
        processed: progress.processed ?? status.processed,
        sessions: progress.sessions ?? status.sessions,
        updatedAt: now,
      },
    };
    return this.set({
      ...this.status,
      phase: this.activePhase(agentStatuses),
      agentStatuses,
      updatedAt: now,
    });
  }

  queueAgentPublication(agentName: string): ScanStatusEvent | null {
    const status = this.status.agentStatuses[agentName];
    if (
      !this.hasActiveAgents(this.status.agentStatuses) ||
      !status ||
      (status.status !== "scanning" && status.status !== "finalizing")
    ) {
      return null;
    }

    const now = Date.now();
    const agentStatuses = {
      ...this.status.agentStatuses,
      [agentName]: { ...status, status: "publish-queued" as const, updatedAt: now },
    };
    return this.set({
      ...this.status,
      phase: this.activePhase(agentStatuses),
      agentStatuses,
      updatedAt: now,
    });
  }

  publishAgent(agentName: string): ScanStatusEvent | null {
    const status = this.status.agentStatuses[agentName];
    if (
      !this.hasActiveAgents(this.status.agentStatuses) ||
      !status ||
      (status.status !== "scanning" &&
        status.status !== "finalizing" &&
        status.status !== "publish-queued")
    ) {
      return null;
    }

    const now = Date.now();
    const agentStatuses = {
      ...this.status.agentStatuses,
      [agentName]: { ...status, status: "publishing" as const, updatedAt: now },
    };
    return this.set({
      ...this.status,
      phase: this.activePhase(agentStatuses),
      agentStatuses,
      updatedAt: now,
    });
  }

  finishAgent(
    agentName: string,
    sessionCount?: number,
    completion: ScanCompletion = { completeness: "complete" },
  ): ScanStatusEvent {
    const now = Date.now();
    const previousStatus = this.status.agentStatuses[agentName];
    const total = previousStatus?.total ?? previousStatus?.processed;
    const agentStatuses = {
      ...this.status.agentStatuses,
      [agentName]: {
        agentName,
        status: "complete" as const,
        ...completion,
        total,
        processed: total,
        sessions: sessionCount ?? previousStatus?.sessions ?? 0,
        startedAt: previousStatus?.startedAt,
        updatedAt: now,
        completedAt: now,
      },
    };
    const isActive = this.hasActiveAgents(agentStatuses);

    return this.set({
      ...this.status,
      phase: isActive ? this.activePhase(agentStatuses) : "idle",
      agentStatuses,
      updatedAt: now,
      completedAt: isActive ? undefined : now,
    });
  }

  failAgent(agentName: string, error: string, sessionCount?: number): ScanStatusEvent {
    const now = Date.now();
    const previousStatus = this.status.agentStatuses[agentName];
    const agentStatuses = {
      ...this.status.agentStatuses,
      [agentName]: {
        agentName,
        status: "failed" as const,
        error,
        total: previousStatus?.total,
        processed: previousStatus?.processed,
        sessions: sessionCount ?? previousStatus?.sessions ?? 0,
        startedAt: previousStatus?.startedAt,
        updatedAt: now,
        completedAt: now,
      },
    };
    const isActive = this.hasActiveAgents(agentStatuses);
    return this.set({
      ...this.status,
      phase: isActive ? this.activePhase(agentStatuses) : "idle",
      agentStatuses,
      updatedAt: now,
      completedAt: isActive ? undefined : now,
    });
  }

  finishBatch(): ScanStatusEvent {
    const now = Date.now();
    return this.set({
      ...this.status,
      phase: "idle",
      agentStatuses: Object.fromEntries(
        Object.entries(this.status.agentStatuses).map(([agentName, status]) => [
          agentName,
          status.status === "failed"
            ? { ...status, completedAt: status.completedAt ?? now, updatedAt: now }
            : {
                ...status,
                status: "complete",
                completeness: status.completeness ?? "complete",
                completedAt: status.completedAt ?? now,
                updatedAt: now,
              },
        ]),
      ),
      updatedAt: now,
      completedAt: now,
    });
  }

  updateBackfill(backfill: BackfillStatus): ScanStatusEvent {
    return this.set({
      ...this.status,
      backfill: {
        ...backfill,
        pendingAgents: [...backfill.pendingAgents],
        completedAgents: [...backfill.completedAgents],
        failedAgents: [...backfill.failedAgents],
        progress: backfill.progress ? { ...backfill.progress } : undefined,
        ...(backfill.partialAgents
          ? {
              partialAgents: Object.fromEntries(
                Object.entries(backfill.partialAgents).map(([agentName, completion]) => [
                  agentName,
                  { ...completion },
                ]),
              ),
            }
          : {}),
      },
      updatedAt: Date.now(),
    });
  }

  updateSearchIndexMaintenance(
    searchIndexMaintenance: SearchIndexMaintenanceStatus,
  ): ScanStatusEvent {
    return this.set({
      ...this.status,
      searchIndexMaintenance: {
        ...searchIndexMaintenance,
        pendingAgents: [...searchIndexMaintenance.pendingAgents],
        completedAgents: [...searchIndexMaintenance.completedAgents],
        failedAgents: [...searchIndexMaintenance.failedAgents],
      },
      updatedAt: Date.now(),
    });
  }

  private activePhase(agentStatuses: ScanStatus["agentStatuses"]): ScanStatusEvent["phase"] {
    const { pendingAgents, scanningAgents } = this.agentLists(agentStatuses);
    if (
      pendingAgents.length === 0 &&
      scanningAgents.length > 0 &&
      scanningAgents.every((agentName) => {
        const status = agentStatuses[agentName]?.status;
        return status === "finalizing" || status === "publish-queued" || status === "publishing";
      })
    ) {
      return "publishing";
    }
    return this.status.phase === "initializing" ? "initializing" : "scanning";
  }

  private agentLists(agentStatuses: ScanStatus["agentStatuses"]): AgentLists {
    const pendingAgents: string[] = [];
    const scanningAgents: string[] = [];
    const completedAgents: string[] = [];

    for (const [agentName, status] of Object.entries(agentStatuses)) {
      if (status.status === "pending") pendingAgents.push(agentName);
      else if (status.status === "complete") completedAgents.push(agentName);
      else if (status.status !== "failed") scanningAgents.push(agentName);
    }

    return { pendingAgents, scanningAgents, completedAgents };
  }

  private hasActiveAgents(agentStatuses: ScanStatus["agentStatuses"]): boolean {
    return Object.values(agentStatuses).some(
      (status) => status.status !== "complete" && status.status !== "failed",
    );
  }

  private set(status: ScanStatus): ScanStatusEvent {
    this.status = status;
    return this.snapshot();
  }
}
