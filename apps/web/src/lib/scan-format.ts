import { t } from "../i18n/translate";
/**
 * Scan-status and time-window formatting helpers.
 * Pure display logic consumed by the app shell and sidebar.
 */
import type { AppConfig, ScanStatusEvent } from "./api";

function formatPartialCompletion(
  completion: Pick<
    NonNullable<ScanStatusEvent["agentStatuses"][string]>,
    "sourceFailureCount" | "sourceFailureSummary"
  >,
): string {
  const count = completion.sourceFailureCount;
  const countLabel =
    count == null ? null : t("{0} source{1} failed", [count, count === 1 ? "" : "s"]);
  return [countLabel, completion.sourceFailureSummary].filter((value) => value != null).join(" · ");
}

function hasSourceFailures(
  completion: Pick<
    NonNullable<ScanStatusEvent["agentStatuses"][string]>,
    "sourceFailureCount" | "sourceFailureSummary"
  >,
): boolean {
  return (completion.sourceFailureCount ?? 0) > 0 || completion.sourceFailureSummary != null;
}

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
  if (days === 0 || from == null) return t("All time");
  const fromStr = formatIsoDate(from);
  const toStr = formatIsoDate(to ?? Date.now());
  if (days) return t("Last {0}d · {1} → {2}", [days, fromStr, toStr]);
  return `${fromStr} → ${toStr}`;
}

export function formatSearchSubtitle(query: string, loading: boolean, count: number) {
  if (loading) return query ? t('Searching for "{0}"', [query]) : t("Loading recent sessions");
  return query ? t('{0} matches for "{1}"', [count, query]) : t("{0} recent sessions", [count]);
}

export function formatScanStatusLabel(status: ScanStatusEvent | null): string | null {
  if (!status) return null;
  if (status.backfill?.active) {
    const current = status.backfill.currentAgent;
    const pending = status.backfill.pendingAgents.length;
    const progress = status.backfill.progress;
    const progressLabel =
      (progress?.phase == null ||
        progress.phase === "scanning" ||
        progress.phase === "finalizing") &&
      progress?.total &&
      progress.processed != null
        ? ` · ${progress.processed}/${progress.total}`
        : "";
    const stageLabel =
      progress?.phase === "publish-queued"
        ? t("Full-history publication queued")
        : progress?.phase === "committing"
          ? t("Committing full-history publication")
          : progress?.phase === "indexing"
            ? t("Writing full-history search index")
            : progress?.phase === "publishing"
              ? t("Preparing full-history publication")
              : progress?.phase === "finalizing"
                ? t("Finalizing full-history metadata")
                : t("Scanning full session history");
    return current
      ? `${stageLabel} · ${current}${progressLabel}${pending > 0 ? t(" · {0} history scan queued", [pending]) : ""}`
      : `${stageLabel}${progressLabel}`;
  }
  if (status.backfill?.failedAgents.length) {
    return t("Full-history refresh failed · {0}", [status.backfill.failedAgents.join(", ")]);
  }
  const failedAgent = Object.values(status.agentStatuses ?? {}).find(
    (agentStatus) => agentStatus.status === "failed",
  );
  if (failedAgent) {
    return t("Session refresh failed · {0}{1}", [
      failedAgent.agentName,
      failedAgent.error ? ` · ${failedAgent.error}` : "",
    ]);
  }
  if (status.active && status.phase === "initializing") {
    return t("Initializing recent sessions");
  }

  const partialBackfill = Object.entries(status.backfill?.partialAgents ?? {}).find(
    ([, completion]) => completion.completeness === "partial" && hasSourceFailures(completion),
  );
  if (partialBackfill) {
    const [agentName, completion] = partialBackfill;
    const detail = formatPartialCompletion(completion);
    return t("Full-history refresh completed with partial data · {0}{1}", [
      agentName,
      detail ? ` · ${detail}` : "",
    ]);
  }
  const partialAgent = Object.values(status.agentStatuses ?? {}).find(
    (agentStatus) =>
      agentStatus.status === "complete" &&
      agentStatus.completeness === "partial" &&
      hasSourceFailures(agentStatus),
  );
  if (partialAgent) {
    const detail = formatPartialCompletion(partialAgent);
    return t("Session refresh completed with partial data · {0}{1}", [
      partialAgent.agentName,
      detail ? ` · ${detail}` : "",
    ]);
  }

  if (status.searchIndexMaintenance?.failedAgents.length) {
    return t("Background search index maintenance paused · {0}", [
      status.searchIndexMaintenance.failedAgents.join(", "),
    ]);
  }
  return null;
}

export function formatAgentScanProgress(
  status: ScanStatusEvent | null,
  agentName: string,
): string | null {
  const agentStatus = status?.agentStatuses[agentName];
  if (!agentStatus || agentStatus.status === "complete") return null;
  if (agentStatus.status === "failed") return t("Failed");
  if (agentStatus.status === "finalizing") {
    if (agentStatus.total && agentStatus.processed != null) {
      return `${agentStatus.processed}/${agentStatus.total}`;
    }
    return t("Finalizing");
  }
  if (agentStatus.status === "publishing" || agentStatus.status === "indexing") {
    return t("Publishing");
  }
  if (agentStatus.status === "publish-queued") return t("Queued to publish");
  if (agentStatus.total && agentStatus.processed != null) {
    return `${agentStatus.processed}/${agentStatus.total}`;
  }
  return agentStatus.status === "scanning" ? t("Scanning") : t("Pending");
}
