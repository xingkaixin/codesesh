/**
 * Model composition. Real per-model cost only exists when the message cache is
 * available; without it the card falls back to token share and says so, because
 * pro-rating session cost by tokens would be a fabricated number.
 */
import type { DashboardTotals, ModelCostEntry, ModelDistributionEntry } from "../../lib/api";
import { formatCompact, formatUsd } from "../../lib/format";
import { Panel, PanelHeader } from "../ui/panel";
import { StackedShareBar, type ShareSegment } from "../ui/share-bar";

const LEGEND_LIMIT = 5;
/** Below this share of the total the cache lag is noise, not a missing slice. */
const REMAINDER_THRESHOLD = 0.01;

interface BreakdownEntry extends ShareSegment {
  label: string;
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
  const byCost = hasCost(modelCost);
  const entries = byCost ? costEntries(modelCost, totals.cost) : tokenEntries(modelDistribution);
  const title = byCost ? "Cost by Model" : "Models";

  return (
    <Panel className="p-4">
      <PanelHeader title={title} meta={byCost ? "by cost" : "by tokens"} />

      {entries.length === 0 ? (
        <p className="console-mono mt-3 text-[11px] text-[var(--console-muted)]">No model data</p>
      ) : (
        <>
          <div className="mt-3">
            <StackedShareBar height={9} segments={entries} label={title} />
          </div>
          <ul className="mt-[11px] grid grid-cols-2 gap-x-[14px] gap-y-[6px]">
            {entries.map((entry) => (
              <li key={entry.key} className="flex min-w-0 items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: entry.color }}
                  aria-hidden
                />
                <span className="console-mono min-w-0 flex-1 truncate text-[10.5px] text-[var(--console-text)]">
                  {entry.label}
                </span>
                <span className="console-mono shrink-0 text-[10.5px] text-[var(--console-muted)]">
                  {entry.display}
                </span>
              </li>
            ))}
          </ul>
        </>
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
