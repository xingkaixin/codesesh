import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * Where the tokens went, by model and by agent. Each card pairs a double ring —
 * token share outside, API value share inside — with the table it is drawn from,
 * so a model that is cheap per token reads as a thinner inner arc.
 */
import type { ReactNode } from "react";
import type {
  DashboardAgentStat,
  DashboardTotals,
  ModelCostEntry,
  ModelDistributionEntry,
} from "@codesesh/contract";
import { formatCompact, formatInt, formatShare, formatUsd } from "../../lib/format";
import { modelColor } from "../../lib/model-breakdown";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIcon";
import { Panel } from "../ui/panel";

const MODEL_LIMIT = 5;
const AGENT_LIMIT = 6;
const OTHER_COLOR = "var(--console-border-strong)";
const AGENT_COLORS = [
  "var(--brand)",
  "var(--console-text)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-3)",
];
const RING_GAP_DEGREES = 1.2;

interface BreakdownRow {
  key: string;
  label: string;
  mono?: boolean;
  sub?: string;
  icon?: ReactNode;
  color: string;
  tokens: number;
  cost: number | null;
}

function conicGradient(values: readonly number[], colors: readonly string[]): string {
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (total <= 0) return "var(--console-surface-muted)";
  const gap = values.filter((value) => value > 0).length > 1 ? RING_GAP_DEGREES : 0;
  const stops: string[] = [];
  let angle = 0;
  values.forEach((value, index) => {
    if (value <= 0) return;
    const span = (value / total) * 360;
    const end = angle + Math.max(span - gap, Math.min(span, 0.8));
    stops.push(
      `${colors[index]} ${angle}deg ${end}deg`,
      `transparent ${end}deg ${angle + span}deg`,
    );
    angle += span;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

function ringMask(thickness: number): string {
  return `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness - 0.5}px))`;
}

function UsageRing({
  rows,
  centerValue,
  centerLabel,
}: {
  rows: readonly BreakdownRow[];
  centerValue: string;
  centerLabel: string;
}) {
  const colors = rows.map((row) => row.color);
  const hasCost = rows.some((row) => (row.cost ?? 0) > 0);
  const outer = ringMask(16);
  const inner = ringMask(7);
  return (
    <div aria-hidden className="relative size-[148px] shrink-0">
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background: conicGradient(
            rows.map((row) => row.tokens),
            colors,
          ),
          mask: outer,
          WebkitMask: outer,
        }}
      />
      {hasCost ? (
        <span
          className="absolute inset-6 rounded-full"
          style={{
            background: conicGradient(
              rows.map((row) => row.cost ?? 0),
              colors,
            ),
            mask: inner,
            WebkitMask: inner,
          }}
        />
      ) : null}
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="console-mono text-[17px] text-[var(--console-text)]">{centerValue}</span>
        <span className="text-[10px] text-[var(--console-muted)]">{centerLabel}</span>
      </span>
    </div>
  );
}

function BreakdownCard({
  title,
  meta,
  nameHeader,
  rows,
  centerValue,
  centerLabel,
  footnote,
  rowTestId,
  emptyText,
}: {
  title: string;
  meta: string;
  nameHeader: string;
  rows: readonly BreakdownRow[];
  centerValue: string;
  centerLabel: string;
  footnote?: string;
  rowTestId?: string;
  emptyText: string;
}) {
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const hasCost = totalCost > 0;

  return (
    <Panel role="region" aria-label={title} className="relative flex flex-col">
      <div className="flex min-h-12 items-center gap-3 border-b border-[var(--console-border)] px-[18px] py-2.5">
        <h3 className="text-sm font-semibold text-[var(--console-text)]">{title}</h3>
        <span className="ml-auto text-xs text-[var(--console-muted)]">{meta}</span>
      </div>
      {rows.length === 0 ? (
        <p className="flex-1 px-[18px] py-10 text-center text-sm text-[var(--console-muted)]">
          {emptyText}
        </p>
      ) : (
        <div className="grid flex-1 items-start gap-6 p-[18px] sm:grid-cols-[148px_minmax(0,1fr)]">
          <div className="flex flex-col items-center gap-3">
            <UsageRing rows={rows} centerValue={centerValue} centerLabel={centerLabel} />
            <div
              aria-hidden
              className="flex flex-col gap-1 text-[11px] whitespace-nowrap text-[var(--console-muted)]"
            >
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-3 rounded-full bg-[var(--console-border-strong)]" />
                {t("Outer: tokens")}
              </span>
              {hasCost ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-[3px] w-3 rounded-full bg-[var(--console-border-strong)]" />
                  {t("Inner: API value")}
                </span>
              ) : null}
            </div>
          </div>
          <table className="w-full table-fixed text-xs">
            <caption className="sr-only">{title}</caption>
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr className="text-[11px] text-[var(--console-muted)]">
                <th scope="col" className="pb-1.5 text-left font-normal">
                  {nameHeader}
                </th>
                <th scope="col" className="pb-1.5 text-right font-normal">
                  {t("Tokens")}
                </th>
                <th scope="col" className="pb-1.5 text-right font-normal">
                  {t("API value")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  data-testid={rowTestId}
                  className="border-t border-[var(--console-border)]"
                >
                  <th scope="row" className="py-2 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ background: row.color }}
                      />
                      {row.icon}
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block truncate font-medium text-[var(--console-text)]",
                            row.mono ? "console-mono" : null,
                          )}
                        >
                          {row.label}
                        </span>
                        {row.sub ? (
                          <span className="block truncate text-[10px] text-[var(--console-muted)]">
                            {row.sub}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </th>
                  <td className="console-mono py-2 text-right text-[var(--console-text)]">
                    {formatCompact(row.tokens)}
                    <span className="block text-[10px] text-[var(--console-muted)]">
                      {formatShare(row.tokens / totalTokens)}
                    </span>
                  </td>
                  <td className="console-mono py-2 text-right text-[var(--console-text)]">
                    {row.cost === null || !hasCost ? "—" : formatUsd(row.cost)}
                    {row.cost === null || !hasCost ? null : (
                      <span className="block text-[10px] text-[var(--console-muted)]">
                        {formatShare(row.cost / totalCost)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footnote ? (
        <p className="border-t border-[var(--console-border)] bg-[var(--console-bg)] px-[18px] py-2.5 text-[11px] text-[var(--console-muted)]">
          {footnote}
        </p>
      ) : null}
    </Panel>
  );
}

export function OverviewModelBreakdown({
  models,
  modelCost,
  totals,
}: {
  models: readonly ModelDistributionEntry[];
  modelCost: readonly ModelCostEntry[] | null;
  totals: DashboardTotals;
}) {
  useLocale();

  const costByModel = new Map(modelCost?.map((entry) => [entry.model, entry.cost]));
  const ranked = models.filter((entry) => entry.tokens > 0).toSorted((a, b) => b.tokens - a.tokens);
  const rows: BreakdownRow[] = ranked.slice(0, MODEL_LIMIT).map((entry) => ({
    key: entry.model,
    label: entry.model,
    mono: true,
    sub: t("{0} sessions", [formatInt(entry.sessions)]),
    color: modelColor(entry.model),
    tokens: entry.tokens,
    cost: modelCost ? (costByModel.get(entry.model) ?? 0) : null,
  }));
  const rest = ranked.slice(MODEL_LIMIT);
  const otherTokens = Math.max(totals.tokens - rows.reduce((sum, row) => sum + row.tokens, 0), 0);
  const otherCost = modelCost
    ? Math.max(totals.cost - rows.reduce((sum, row) => sum + (row.cost ?? 0), 0), 0)
    : null;
  if (otherTokens > 0 || (otherCost ?? 0) >= 0.005) {
    rows.push({
      key: "__other",
      label: t("Other"),
      mono: false,
      sub: rest.length > 0 ? rest.map((entry) => entry.model).join(" · ") : undefined,
      color: OTHER_COLOR,
      tokens: otherTokens,
      cost: otherCost,
    });
  }

  return (
    <BreakdownCard
      title={t("By model")}
      meta={`${t("{0} models", [ranked.length])} · ${t("by tokens")}`}
      nameHeader={t("Model")}
      rows={rows}
      centerValue={formatCompact(totals.tokens)}
      centerLabel={t("Tokens")}
      footnote={
        rows.length > 0
          ? t("A session can use several models, so session counts do not add up.")
          : undefined
      }
      emptyText={t("No model data")}
    />
  );
}

export function OverviewAgentBreakdown({
  perAgent,
  totals,
}: {
  perAgent: readonly DashboardAgentStat[];
  totals: DashboardTotals;
}) {
  useLocale();

  const hasCost = perAgent.some((agent) => agent.cost > 0);
  const ranked = perAgent.toSorted((a, b) => b.tokens - a.tokens || b.sessions - a.sessions);
  const rows: BreakdownRow[] = ranked.slice(0, AGENT_LIMIT).map((agent, index) => ({
    key: agent.name,
    label: agent.displayName,
    sub: t("{0} sessions", [formatInt(agent.sessions)]),
    icon: (
      <AgentIcon
        icon={agent.icon}
        iconColored={agent.iconColored}
        alt={agent.displayName}
        className="size-3.5 shrink-0 text-[var(--console-text)]"
      />
    ),
    color: AGENT_COLORS[index] ?? OTHER_COLOR,
    tokens: agent.tokens,
    cost: hasCost ? agent.cost : null,
  }));
  const rest = ranked.slice(AGENT_LIMIT);
  if (rest.length > 0) {
    rows.push({
      key: "__other",
      label: t("Other"),
      sub: t("{0} sessions", [formatInt(rest.reduce((sum, agent) => sum + agent.sessions, 0))]),
      color: OTHER_COLOR,
      tokens: rest.reduce((sum, agent) => sum + agent.tokens, 0),
      cost: hasCost ? rest.reduce((sum, agent) => sum + agent.cost, 0) : null,
    });
  }

  return (
    <BreakdownCard
      title={t("By agent")}
      meta={`${t("{0} agents", [perAgent.length])} · ${t("by tokens")}`}
      nameHeader={t("Agent")}
      rows={rows}
      centerValue={formatInt(totals.sessions)}
      centerLabel={t("Sessions")}
      rowTestId="overview-agent-row"
      emptyText={t("No data")}
    />
  );
}
