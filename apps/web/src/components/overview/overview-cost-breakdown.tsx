/**
 * Model composition, as a ring whose centre carries the total. Real per-model
 * cost only exists when the message cache is available; without it the card
 * falls back to token share and says so, because pro-rating session cost by
 * tokens would be a fabricated number.
 */
import { useMemo, useState } from "react";

import type { DashboardTotals, ModelCostEntry, ModelDistributionEntry } from "../../lib/api";
import { formatCompact, formatPercent, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Panel, PanelHeader } from "../ui/panel";
import { TileDonut } from "../ui/tile-donut";

const LEGEND_LIMIT = 5;
const DONUT_SIZE = 142;
/** Below this share of the total the cache lag is noise, not a missing slice. */
const REMAINDER_THRESHOLD = 0.01;

interface BreakdownEntry {
  key: string;
  label: string;
  value: number;
  color: string;
  display: string;
}

function hasCost(modelCost: ModelCostEntry[] | null): modelCost is ModelCostEntry[] {
  return modelCost !== null && modelCost.some((entry) => entry.cost > 0);
}

function costEntries(modelCost: ModelCostEntry[], totalCost: number): BreakdownEntry[] {
  const top = [...modelCost].sort((a, b) => b.cost - a.cost).slice(0, LEGEND_LIMIT);
  const entries = top.map((entry, index) => ({
    key: entry.model,
    label: entry.model,
    value: entry.cost,
    color: `var(--chart-${index + 1})`,
    display: formatUsd(entry.cost),
  }));

  const remainder = totalCost - top.reduce((sum, entry) => sum + entry.cost, 0);
  if (totalCost > 0 && remainder > totalCost * REMAINDER_THRESHOLD) {
    entries.push({
      key: "__remainder",
      label: "Other",
      value: remainder,
      color: "var(--console-border-strong)",
      display: formatUsd(remainder),
    });
  }
  return entries;
}

function tokenEntries(modelDistribution: ModelDistributionEntry[]): BreakdownEntry[] {
  return [...modelDistribution]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LEGEND_LIMIT)
    .map((entry, index) => ({
      key: entry.model,
      label: entry.model,
      value: entry.tokens,
      color: `var(--chart-${index + 1})`,
      display: formatCompact(entry.tokens),
    }));
}

export function OverviewCostBreakdown({
  modelCost,
  modelDistribution,
  totals,
}: {
  modelCost: ModelCostEntry[] | null;
  modelDistribution: ModelDistributionEntry[];
  totals: DashboardTotals;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const { byCost, entries } = useMemo(() => {
    const byCost = hasCost(modelCost);
    return {
      byCost,
      entries: byCost ? costEntries(modelCost, totals.cost) : tokenEntries(modelDistribution),
    };
  }, [modelCost, modelDistribution, totals.cost]);
  // Shares are of the ring, so they always add up to it; the centre reports the
  // scope total the KPI row already shows, which the ring covers in full once
  // the per-model rows agree with it.
  const ringTotal = entries.reduce((sum, entry) => sum + entry.value, 0);
  const shares = useMemo(
    () => entries.map((entry) => (ringTotal > 0 ? entry.value / ringTotal : 1 / entries.length)),
    [entries, ringTotal],
  );

  const title = byCost ? "Cost by Model" : "Models";

  return (
    <Panel className="p-4">
      <PanelHeader title={title} meta={byCost ? "by cost" : "by tokens"} />

      {entries.length === 0 ? (
        <p className="console-mono mt-3 text-[11px] text-[var(--console-muted)]">No model data</p>
      ) : (
        <div className="mt-[14px] flex items-center gap-[18px]">
          <TileDonut
            shares={shares}
            colors={entries.map((entry) => entry.color)}
            hovered={hovered}
            onHover={setHovered}
            size={DONUT_SIZE}
          >
            <span className="console-mono text-[16px] font-semibold text-[var(--console-text)]">
              {byCost ? formatUsd(totals.cost) : formatCompact(totals.tokens)}
            </span>
            <span className="console-mono mt-0.5 text-[9px] text-[var(--console-muted)]">
              {byCost ? "total cost" : "total tokens"}
            </span>
          </TileDonut>

          <ul className="flex min-w-0 flex-1 flex-col gap-[7px]">
            {entries.map((entry, index) => (
              <li
                key={entry.key}
                className={cn(
                  "flex min-w-0 items-center gap-2 transition-opacity",
                  hovered !== null && hovered !== index ? "opacity-45" : null,
                )}
                onPointerEnter={() => setHovered(index)}
                onPointerLeave={() => setHovered(null)}
              >
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: entry.color }}
                  aria-hidden
                />
                <span className="console-mono min-w-0 flex-1 truncate text-[10.5px] text-[var(--console-text)]">
                  {entry.label}
                </span>
                <span className="console-mono w-[34px] shrink-0 text-right text-[10.5px] text-[var(--console-muted)]">
                  {formatPercent(ringTotal > 0 ? entry.value / ringTotal : 0)}
                </span>
                <span className="console-mono w-[54px] shrink-0 text-right text-[10.5px] text-[var(--console-text)]">
                  {entry.display}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="console-mono mt-3 border-t border-dashed border-[var(--console-border)] pt-3 text-[10.5px] text-[var(--console-muted)]">
        {byCost ? (
          <>
            <span className="mr-1.5 rounded-sm bg-[var(--brand-soft)] px-1.5 py-0.5 text-[var(--brand)]">
              Estimated
            </span>
            {formatUsd(totals.costEstimated)} from model unit price,{" "}
            {formatUsd(totals.costRecorded)} from agent records
          </>
        ) : (
          "Per-model cost needs the message cache, which is unavailable here; showing token share instead."
        )}
      </p>
    </Panel>
  );
}
