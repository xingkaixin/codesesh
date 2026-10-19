import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import type { SessionDetail } from "@codesesh/contract";
import { formatCompact, formatInt, formatShare, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { SessionDetailToc } from "./toc";

function Stat({
  label,
  badge,
  value,
  detail,
}: {
  label: string;
  badge?: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] px-4 py-3 shadow-[var(--shadow-raised)]">
      <span className="flex items-center gap-2 text-xs text-[var(--console-muted)]">
        {label}
        {badge ? (
          <span className="rounded-full bg-[var(--console-warning-bg)] px-2 text-[11px] font-medium text-[var(--console-warning)]">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="console-mono text-[22px] leading-tight font-light text-[var(--console-text)]">
        {value}
      </span>
      {detail ? <span className="text-[11px] text-[var(--console-muted)]">{detail}</span> : null}
    </div>
  );
}

/** Totals come from the session head; role and tool counts come from the loaded pages. */
export function SessionStats({
  session,
  toc,
  className,
}: {
  session: SessionDetail;
  toc: SessionDetailToc;
  className?: string;
}) {
  useLocale();

  const { stats } = session;
  const messageTotal = session.message_total ?? stats.message_count;
  const partial = session.messages.length < messageTotal;
  const loadedNote = partial
    ? t("From {0} of {1} loaded messages", [
        formatInt(session.messages.length),
        formatInt(messageTotal),
      ])
    : undefined;
  const toolCalls = toc.tools.reduce((sum, tool) => sum + tool.count, 0);
  const topTools = toc.tools
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((tool) => `${tool.label} ${formatInt(tool.count)}`)
    .join(" · ");
  const tokens = stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens;
  const cacheRead = stats.total_cache_read_tokens ?? 0;

  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
      <Stat
        label={t("Messages")}
        value={formatInt(messageTotal)}
        detail={
          loadedNote ??
          t("You {0} · Agent {1}", [
            formatInt(toc.counts.user),
            formatInt(toc.counts.agent_message),
          ])
        }
      />
      <Stat label={t("Tool calls")} value={formatInt(toolCalls)} detail={loadedNote ?? topTools} />
      <Stat
        label={t("Tokens")}
        value={formatCompact(tokens)}
        detail={tokens > 0 ? t("Cache hit {0}", [formatShare(cacheRead / tokens)]) : undefined}
      />
      <Stat
        label={t("Cost")}
        badge={stats.cost_source === "estimated" ? t("Estimated") : undefined}
        value={formatUsd(stats.total_cost)}
      />
    </div>
  );
}
