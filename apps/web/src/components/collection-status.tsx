import {
  AGENT_CATALOG,
  type AgentCollectionStatus,
  type NodeAgentActivity,
} from "@codesesh/contract";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { formatNumber, formatRelativeTime } from "../lib/format";
import { AgentIcon } from "./AgentIcon";

export function CollectionSources({
  sources,
  stale = false,
  uploading = false,
  activity,
  ignored = [],
  onStopIgnoring,
}: {
  sources: Record<string, AgentCollectionStatus> | undefined;
  stale?: boolean;
  uploading?: boolean;
  activity?: Record<string, NodeAgentActivity>;
  ignored?: string[];
  onStopIgnoring?: (agent: string) => void;
}) {
  useLocale();
  if (!sources) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("Agent source details unavailable. Upgrade the collector to report them.")}
      </p>
    );
  }
  const entries = Object.entries(sources);
  const absent = entries.filter(([, status]) => status.presence === "not-found" && !status.error);
  const lastActivity = (name: string) => activity?.[name]?.lastActivity ?? 0;
  const visible = entries
    .filter(([, status]) => status.presence !== "not-found" || status.error)
    .sort(([left], [right]) => lastActivity(right) - lastActivity(left));
  const row = ([name, status]: [string, AgentCollectionStatus]) => {
    const agent = AGENT_CATALOG.find((entry) => entry.name === name);
    const isIgnored = status.presence === "missing" && ignored.includes(name);
    const warning = Boolean(status.error) || (status.presence === "missing" && !isIgnored);
    const stats = activity?.[name];
    const pending = status.presence === "pending";
    const absent = status.presence === "not-found" && !status.error;
    const label = isIgnored ? t("Ignored") : sourceLabel(status, uploading);
    return (
      <li key={name} className="flex items-start gap-3 py-3">
        {agent && (
          <AgentIcon
            icon={agent.icon}
            iconColored={"iconColored" in agent && agent.iconColored}
            alt=""
            className="mt-0.5 size-5 shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <span className="font-medium">{agent?.displayName ?? name}</span>
            <span
              className={
                stale || absent || pending || isIgnored
                  ? "text-muted-foreground"
                  : warning || !status.complete || uploading
                    ? "text-[var(--console-warning)]"
                    : "text-[var(--console-success)]"
              }
            >
              {label}
            </span>
          </div>
          {stats && stats.sessions > 0 && (
            <p
              className="mt-0.5 text-xs text-muted-foreground"
              title={stats.lastActivity ? new Date(stats.lastActivity).toLocaleString() : undefined}
            >
              {t("{0} sessions · last active {1}", [
                formatNumber(stats.sessions),
                formatRelativeTime(stats.lastActivity),
              ])}
            </p>
          )}
          {isIgnored ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Collected sessions stay available. Collection resumes if the source returns.")}
              {onStopIgnoring && (
                <button
                  type="button"
                  className="ml-2 underline underline-offset-2 hover:text-[var(--console-text)]"
                  onClick={() => onStopIgnoring(name)}
                >
                  {t("Stop ignoring")}
                </button>
              )}
            </p>
          ) : status.error ? (
            <details className="mt-1 text-xs text-[var(--console-error)]">
              <summary className="cursor-pointer">{t("Error details")}</summary>
              <p className="mt-1 break-words">{status.error}</p>
            </details>
          ) : status.presence === "missing" ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Previously discovered. Check the source location and permissions.")}
            </p>
          ) : !stale && !absent && !pending && !status.complete ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Older messages may not appear in search yet.")}
            </p>
          ) : null}
        </div>
      </li>
    );
  };
  return (
    <div>
      {stale && (
        <p className="mb-2 text-xs text-muted-foreground">
          {t("Last reported state; Worker status may have changed.")}
        </p>
      )}
      {visible.length > 0 && <ul className="divide-y divide-border">{visible.map(row)}</ul>}
      {absent.length > 0 && (
        <details className="mt-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("Not discovered · {0}", [absent.length])}</summary>
          <p className="mt-2">{t("No records found in the configured source locations.")}</p>
          <ul className="mt-1 divide-y divide-border">{absent.map(row)}</ul>
        </details>
      )}
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("No collection sources enabled.")}</p>
      )}
    </div>
  );
}

function sourceLabel(status: AgentCollectionStatus, uploading: boolean) {
  if (status.error) return t("Collection failed");
  switch (status.presence) {
    case "missing":
      return t("Source no longer found");
    case "not-found":
      return t("Not discovered");
    case "pending":
      return t("Not checked yet");
    case "available":
      if (!status.complete) return t("Collecting history");
      return uploading ? t("Collected; uploads pending") : t("Up to date");
  }
}
