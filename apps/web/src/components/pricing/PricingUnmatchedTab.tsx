import type { UnmatchedModelStat, UpsertPricingOverrideRequest } from "@codesesh/contract";
import { useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { formatCompact, formatInt } from "../../lib/format";
import { AgentIcon } from "../AgentIcon";
import { EmptyState } from "../ui/empty-state";
import { CheckCircle2 } from "../ui/icons";
import { PricingRuleEditor } from "./PricingRuleEditor";

export interface PricingUnmatchedTabProps {
  unmatchedModels: readonly UnmatchedModelStat[];
  agentCatalog: AgentCatalog;
  savingModel: string | null;
  emptySummary: string;
  onSave: (request: UpsertPricingOverrideRequest) => Promise<void>;
}

export function PricingUnmatchedTab({
  unmatchedModels,
  agentCatalog,
  savingModel,
  emptySummary,
  onSave,
}: PricingUnmatchedTabProps) {
  useLocale();

  const [editingModel, setEditingModel] = useState<string | null>(null);

  if (unmatchedModels.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="size-5" aria-hidden="true" />}
        title={t("All models in range are priced")}
      >
        <p className="text-[11px]">{emptySummary}</p>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-2.5">
      {unmatchedModels.map((stat) => {
        const isEditing = editingModel === stat.modelKey;
        const saving = savingModel === stat.modelKey || savingModel === stat.displayModel;

        return (
          <section
            key={stat.modelKey}
            className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="console-mono break-all text-xs font-medium text-[var(--console-text)]">
                  {stat.displayModel}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {stat.agents.map((agentKey) => {
                    const info = findAgent(agentCatalog, agentKey);
                    const label = info?.displayName ?? agentKey;
                    return (
                      <span
                        key={agentKey}
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--console-text-secondary)]"
                      >
                        {info?.icon ? (
                          <AgentIcon
                            icon={info.icon}
                            iconColored={info.iconColored}
                            alt=""
                            className="size-3 shrink-0"
                          />
                        ) : null}
                        <span>{label}</span>
                      </span>
                    );
                  })}
                  <span className="console-mono rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--console-muted)]">
                    {t("{0} sessions", [formatInt(stat.sessionCount)])}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingModel(isEditing ? null : stat.modelKey)}
                className="shrink-0 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-1 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
              >
                {isEditing ? t("Close") : t("Set price")}
              </button>
            </div>

            <dl className="mt-2.5 grid grid-cols-4 gap-1.5 rounded-md bg-[var(--console-surface-muted)] px-2.5 py-1.5 text-[11px]">
              <div>
                <dt className="text-[var(--console-muted)]">{t("In")}</dt>
                <dd
                  title={formatInt(stat.inputTokens)}
                  className="console-mono font-medium text-[var(--console-text)]"
                >
                  {formatCompact(stat.inputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--console-muted)]">{t("Out")}</dt>
                <dd
                  title={formatInt(stat.outputTokens)}
                  className="console-mono font-medium text-[var(--console-text)]"
                >
                  {formatCompact(stat.outputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--console-muted)]">{t("Cache R")}</dt>
                <dd
                  title={formatInt(stat.cacheReadTokens)}
                  className="console-mono font-medium text-[var(--console-text)]"
                >
                  {formatCompact(stat.cacheReadTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--console-muted)]">{t("Cache W")}</dt>
                <dd
                  title={formatInt(stat.cacheWriteTokens)}
                  className="console-mono font-medium text-[var(--console-text)]"
                >
                  {formatCompact(stat.cacheWriteTokens)}
                </dd>
              </div>
            </dl>

            {isEditing ? (
              <PricingRuleEditor
                model={stat.displayModel}
                saving={saving}
                onSave={async (request) => {
                  await onSave(request);
                  setEditingModel(null);
                }}
                onCancel={() => setEditingModel(null)}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
