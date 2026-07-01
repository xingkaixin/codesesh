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
  if (from == null) return "All time";
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
  if (!status?.active) return null;

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

  if (status.phase === "initializing") {
    return `First-run setup: indexing all local sessions${agentProgress}. Your selected time window appears after this finishes.`;
  }
  if (status.phase === "indexing") return "Preparing local session index";

  if (total > 0) {
    return current
      ? `Checking for new or changed sessions · ${current}${itemProgress} · ${completed}/${total} agents ready`
      : `Checking for new or changed sessions · ${completed}/${total} agents ready`;
  }
  return "Checking for new or changed sessions";
}

export function formatBackfillLabel(status: ScanStatusEvent | null): string | null {
  if (!status?.backfill?.active) return null;
  const current = status.backfill.currentAgent;
  return current
    ? `Reconciling full session history in the background · ${current}`
    : "Reconciling full session history in the background";
}

export function formatAgentScanProgress(
  status: ScanStatusEvent | null,
  agentName: string,
): string | null {
  const agentStatus = status?.agentStatuses[agentName];
  if (!agentStatus || agentStatus.status === "complete") return null;
  if (agentStatus.total && agentStatus.processed != null) {
    return `${agentStatus.processed}/${agentStatus.total}`;
  }
  return agentStatus.status === "scanning" ? "Scanning" : "Pending";
}

export function getAgentDisplayCount(
  status: ScanStatusEvent | null,
  agentName: string,
  fallback: number,
): number {
  const agentStatus = status?.agentStatuses[agentName];
  return agentStatus?.status === "complete" && agentStatus.sessions != null
    ? agentStatus.sessions
    : fallback;
}

export function formatRelativeTime(timestamp?: number) {
  if (!timestamp) return "unknown";
  const diff = Date.now() - timestamp;
  if (Number.isNaN(diff) || diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
