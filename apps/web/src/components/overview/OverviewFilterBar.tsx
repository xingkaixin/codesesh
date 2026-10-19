import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * The overview hero: which range the cards cover, plus the source and agent pickers.
 *
 * Which project the dashboard covers is decided by navigation (the sidebar),
 * not by a control inside the page — so there is no scope switcher here. The
 * time range itself is changed from the page bar.
 */
import type { ReactNode } from "react";
import type { AgentCatalog } from "../../lib/agents";
import { formatIsoDate } from "../../lib/scan-format";
import type { TimeWindow, TimeWindowPreset } from "../../lib/time-window";
import { NativeSelect } from "../ui/native-select";

const ALL_AGENTS = "__all__";

const PRESET_TITLE: Record<TimeWindowPreset, string> = {
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
  custom: "Custom range",
};

export function OverviewFilterBar({
  agent,
  onAgentChange,
  agentCatalog,
  scopeCounts,
  window,
  rangePreset,
  sourcePicker,
}: {
  agent?: string;
  onAgentChange?: (agent?: string) => void;
  agentCatalog: AgentCatalog;
  scopeCounts?: { projects: number; agents: number };
  window: TimeWindow | null;
  rangePreset: TimeWindowPreset | null;
  sourcePicker?: ReactNode;
}) {
  useLocale();

  const bounded = window && window.days !== 0 && window.from != null && window.to != null;
  const details = [
    bounded ? `${formatIsoDate(window.from!)} – ${formatIsoDate(window.to!)}` : null,
    scopeCounts ? t("{0} agents", [scopeCounts.agents]) : null,
    scopeCounts ? t("{0} projects", [scopeCounts.projects]) : null,
    bounded && window.days ? t("Compared with the previous {0} days", [window.days]) : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="console-eyebrow">{t("Range")}</span>
        <h2 className="console-display text-2xl leading-tight font-light text-[var(--console-text)] sm:text-[28px]">
          {t(PRESET_TITLE[rangePreset ?? "all"])}
        </h2>
        {details.length > 0 ? (
          <p className="text-xs text-[var(--console-muted)]">{details.join(" · ")}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sourcePicker}
        {onAgentChange ? (
          <NativeSelect
            aria-label={t("Filter by agent")}
            value={agent ?? ALL_AGENTS}
            onChange={(event) =>
              onAgentChange(event.target.value === ALL_AGENTS ? undefined : event.target.value)
            }
            className="h-7 rounded-lg border-[var(--console-border)] bg-[var(--console-bg)] py-0 pl-3 text-xs font-medium shadow-[var(--shadow-raised)]"
          >
            <option value={ALL_AGENTS}>{t("All agents")}</option>
            {agentCatalog.active.map((entry) => (
              <option key={entry.name} value={entry.name.toLowerCase()}>
                {entry.displayName}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>
    </div>
  );
}
