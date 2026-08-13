/**
 * Scan-status and time-window formatting helpers.
 * Pure display logic consumed by the app shell and sidebar.
 */
import type { AppConfig, ScanStatusEvent } from "./api";

export function formatIsoDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatWindowLabel(config: AppConfig | null): string | null {
  if (!config) return null;
  const { from, to, days } = config.window;
  if (days === 0 || from == null) return "All time";
  const fromStr = formatIsoDate(from);
  const toStr = formatIsoDate(to ?? Date.now());
  if (days) return `Last ${days}d · ${fromStr} → ${toStr}`;
  return `${fromStr} → ${toStr}`;
}

export function formatSearchSubtitle(query: string, loading: boolean, count: number) {
  if (loading) return query ? `Searching for "${query}"` : "Loading recent sessions";
  return query ? `${count} matches for "${query}"` : `${count} recent sessions`;
}

export function formatScanStatusLabel(status: ScanStatusEvent | null): string | null {
  if (!status) return null;
  if (status.backfill?.active) {
    const current = status.backfill.currentAgent;
    const pending = status.backfill.pendingAgents.length;
    const progress = status.backfill.progress;
    const progressLabel =
      progress?.total && progress.processed != null
        ? ` · ${progress.processed}/${progress.total}`
        : "";
    const stageLabel =
      progress?.phase === "publish-queued"
        ? "Full-history publication queued"
        : progress?.phase === "publishing" || progress?.phase === "indexing"
          ? "Publishing full-history sessions"
          : progress?.phase === "finalizing"
            ? "Finalizing full-history metadata"
            : "Scanning full session history";
    return current
      ? `${stageLabel} · ${current}${progressLabel}${pending > 0 ? ` · ${pending} history scan queued` : ""}`
      : `${stageLabel}${progressLabel}`;
  }
  if (status.backfill?.failedAgents.length) {
    return `Full-history refresh failed · ${status.backfill.failedAgents.join(", ")}`;
  }
  const failedAgent = Object.values(status.agentStatuses ?? {}).find(
    (agentStatus) => agentStatus.status === "failed",
  );
  if (failedAgent) {
    return `Session refresh failed · ${failedAgent.agentName}${failedAgent.error ? ` · ${failedAgent.error}` : ""}`;
  }
  if (status.active) {
    const completed = status.completedAgents.length;
    const total = status.totalAgents;
    const current = status.scanningAgents[0];
    const currentStatus = current ? status.agentStatuses[current] : null;
    const itemProgress =
      currentStatus?.total && currentStatus.processed != null
        ? ` · ${currentStatus.processed}/${currentStatus.total}`
        : "";
    const agentProgress =
      total > 0
        ? current
          ? ` · ${current}${itemProgress} · ${completed}/${total} agents ready`
          : ` · ${completed}/${total} agents ready`
        : "";
    const stageLabel =
      currentStatus?.status === "publish-queued"
        ? "Session publication queued"
        : currentStatus?.status === "finalizing"
          ? "Finalizing session metadata"
          : currentStatus?.status === "publishing" ||
              currentStatus?.status === "indexing" ||
              status.phase === "publishing" ||
              status.phase === "indexing"
            ? "Publishing session updates"
            : "Checking for new or changed sessions";

    if (status.phase === "initializing") {
      return `Initializing recent sessions${agentProgress}`;
    }
    if (status.phase === "publishing" || status.phase === "indexing") {
      return `${stageLabel}${agentProgress}`;
    }

    if (total > 0) {
      return current
        ? `${stageLabel} · ${current}${itemProgress} · ${completed}/${total} agents ready`
        : `Checking for new or changed sessions · ${completed}/${total} agents ready`;
    }
    return "Checking for new or changed sessions";
  }

  if (status.searchIndexMaintenance?.active) {
    const current = status.searchIndexMaintenance.currentAgent;
    const remaining = status.searchIndexMaintenance.remaining;
    return `Updating search index in background${current ? ` · ${current}` : ""}${remaining != null ? ` · ${remaining} remaining` : ""}`;
  }
  if (status.searchIndexMaintenance?.failedAgents.length) {
    return `Background search index maintenance paused · ${status.searchIndexMaintenance.failedAgents.join(", ")}`;
  }
  return null;
}

export function formatAgentScanProgress(
  status: ScanStatusEvent | null,
  agentName: string,
): string | null {
  const agentStatus = status?.agentStatuses[agentName];
  if (!agentStatus || agentStatus.status === "complete") return null;
  if (agentStatus.status === "failed") return "Failed";
  if (agentStatus.status === "finalizing") {
    if (agentStatus.total && agentStatus.processed != null) {
      return `${agentStatus.processed}/${agentStatus.total}`;
    }
    return "Finalizing";
  }
  if (agentStatus.status === "publishing" || agentStatus.status === "indexing") {
    return "Publishing";
  }
  if (agentStatus.status === "publish-queued") return "Queued to publish";
  if (agentStatus.total && agentStatus.processed != null) {
    return `${agentStatus.processed}/${agentStatus.total}`;
  }
  return agentStatus.status === "scanning" ? "Scanning" : "Pending";
}
