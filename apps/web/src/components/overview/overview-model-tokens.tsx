import { useMemo, useState } from "react";
import type { ModelDistributionEntry } from "../../lib/api";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { formatCompact, formatInt } from "../../lib/format";
import { tokenBreakdown } from "../../lib/model-breakdown";
import { cn } from "../../lib/utils";
import { ChartTooltip } from "../ui/chart-tooltip";
import { Panel, PanelHeader } from "../ui/panel";
import { TileShareBar } from "../ui/tile-share-bar";

export function OverviewModelTokens({
  models,
  totalTokens,
}: {
  models: ModelDistributionEntry[];
  totalTokens: number;
}) {
  const locale = useLocale();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const entries = useMemo(
    () => tokenBreakdown(models, totalTokens),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Labels and formatters read the active locale.
    [locale, models, totalTokens],
  );
  const shares = entries.map((entry) => entry.value / totalTokens);
  const percentages = shares.map((share) =>
    share > 0 && share < 0.001
      ? "<0.1%"
      : share.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 }),
  );
  const itemLabels = entries.map(
    (entry, index) =>
      `${entry.label}: ${formatInt(entry.value)} ${t("tokens")}, ${percentages[index]}`,
  );
  const activeIndex = entries.findIndex((entry) => entry.key === activeKey);
  const active = entries[activeIndex];
  const tooltipPosition =
    (shares.slice(0, activeIndex).reduce((sum, share) => sum + share, 0) +
      (shares[activeIndex] ?? 0) / 2) *
    100;
  const onHover = (index: number | null) =>
    setActiveKey(index === null ? null : (entries[index]?.key ?? null));

  return (
    <Panel role="region" aria-label={t("Tokens by Model")} className="p-4">
      <PanelHeader
        title={t("Tokens by Model")}
        meta={`${formatCompact(totalTokens)} ${t("total tokens")}`}
      />
      <p className="console-mono mt-1 text-[10.5px] text-[var(--console-muted)]">
        {t("Token share in the selected range, including cache tokens.")}
      </p>
      {totalTokens <= 0 ? (
        <p className="console-mono mt-3 text-[11px] text-[var(--console-muted)]">
          {t("No usage data")}
        </p>
      ) : (
        <>
          <div className="relative mt-3">
            <TileShareBar
              shares={shares}
              colors={entries.map((entry) => entry.color)}
              hovered={activeIndex < 0 ? null : activeIndex}
              onHover={onHover}
              ariaLabel={t("Model token distribution chart")}
              itemLabels={itemLabels}
            />
            {active ? (
              <ChartTooltip index={activeIndex} count={entries.length} position={tooltipPosition}>
                <div className="font-semibold">{active.label}</div>
                <div>
                  {formatInt(active.value)} {t("tokens")} · {percentages[activeIndex]}
                </div>
              </ChartTooltip>
            ) : null}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {entries.map((entry, index) => (
              <li key={entry.key} className="min-w-0 max-w-full">
                <button
                  type="button"
                  aria-label={itemLabels[index]}
                  className={cn(
                    "console-mono flex max-w-full items-center gap-1.5 rounded-sm text-[10.5px] text-[var(--console-text)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--brand)]",
                    active && active.key !== entry.key ? "opacity-45" : null,
                  )}
                  onPointerEnter={() => setActiveKey(entry.key)}
                  onPointerLeave={() => setActiveKey(null)}
                  onFocus={() => setActiveKey(entry.key)}
                  onBlur={() => setActiveKey(null)}
                  onClick={() => setActiveKey(entry.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setActiveKey(null);
                  }}
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: entry.color }}
                  />
                  <span className="truncate">{entry.label}</span>
                  <span className="shrink-0 text-[var(--console-muted)]">
                    {entry.display} · {percentages[index]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
