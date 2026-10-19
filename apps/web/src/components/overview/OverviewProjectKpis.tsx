import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import type { DashboardTotals } from "@codesesh/contract";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import {
  formatCompact,
  formatDelta,
  formatInt,
  formatRelativeTime,
  formatShare,
  formatUsd,
} from "../../lib/format";
import { cn } from "../../lib/utils";

function Kpi({
  label,
  badge,
  value,
  detail,
  warning = false,
}: {
  label: string;
  badge?: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] px-4 py-3.5 shadow-[var(--shadow-raised)]">
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--console-muted)]">
        <h3 className="font-normal">{label}</h3>
        {badge ? (
          <span className="rounded-full bg-[var(--console-warning-bg)] px-2 text-[11px] font-medium text-[var(--console-warning)]">
            {badge}
          </span>
        ) : null}
      </div>
      <p className="console-mono truncate text-[22px] leading-[1.25] font-light tracking-[-0.01em] text-[var(--console-text)] tabular-nums">
        {value}
      </p>
      <p
        className={cn(
          "truncate text-[11px]",
          warning ? "font-medium text-[var(--console-warning)]" : "text-[var(--console-muted)]",
        )}
      >
        {detail || "—"}
      </p>
    </section>
  );
}

export function OverviewProjectKpis({
  totals,
  rangeDays,
  agentCatalog,
}: {
  totals: DashboardTotals;
  rangeDays?: number;
  agentCatalog: AgentCatalog;
}) {
  useLocale();

  const previous = totals.previous;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");
  const delta = (current: number, base: number | undefined) =>
    base === undefined ? null : formatDelta(current, base);
  const latestAgent = totals.latestActivityAgent
    ? (findAgent(agentCatalog, totals.latestActivityAgent)?.displayName ??
      totals.latestActivityAgent)
    : null;

  return (
    <div
      aria-label={t("Usage summary")}
      role="group"
      className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3"
    >
      <Kpi
        label={t("Sessions")}
        value={formatInt(totals.sessions)}
        detail={join(
          delta(totals.sessions, previous?.sessions),
          rangeDays ? t("{0}/day", [(totals.sessions / rangeDays).toFixed(1)]) : null,
        )}
      />
      <Kpi
        label={t("Messages")}
        value={formatInt(totals.messages)}
        detail={join(
          delta(totals.messages, previous?.messages),
          totals.sessions > 0
            ? t("{0}/session", [(totals.messages / totals.sessions).toFixed(1)])
            : null,
        )}
      />
      <Kpi
        label={t("Tokens")}
        value={formatCompact(totals.tokens)}
        detail={join(
          delta(totals.tokens, previous?.tokens),
          totals.tokens > 0
            ? t("Cache hit {0}", [formatShare(totals.cacheReadTokens / totals.tokens)])
            : null,
        )}
      />
      <Kpi
        label={t("Cost")}
        badge={totals.costEstimated > 0 ? t("Estimated") : undefined}
        value={formatUsd(totals.cost)}
        detail={join(delta(totals.cost, previous?.cost))}
        warning={previous?.cost !== undefined && totals.cost > previous.cost}
      />
      <Kpi
        label={t("Latest Activity")}
        value={totals.latestActivity ? formatRelativeTime(totals.latestActivity) : "—"}
        detail={latestAgent ?? ""}
      />
    </div>
  );
}
