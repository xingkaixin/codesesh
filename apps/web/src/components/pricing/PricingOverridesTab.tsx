import type {
  ModelPriceOverrideView,
  PricingRatePerMillion,
  UpsertPricingOverrideRequest,
} from "@codesesh/contract";
import { useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { EmptyState } from "../ui/empty-state";
import { Receipt } from "../ui/icons";
import { PricingRuleEditor } from "./PricingRuleEditor";
import { formatRateSummaryValues, sortOverridesByAttention } from "./pricing-format";

export interface PricingOverridesTabProps {
  overrides: readonly ModelPriceOverrideView[];
  pendingModel: string | null;
  onSave: (request: UpsertPricingOverrideRequest) => Promise<void>;
  onAcknowledge: (model: string) => Promise<void>;
  onDelete: (model: string) => Promise<void>;
}

function RateStrip({ rates }: { rates: PricingRatePerMillion }) {
  useLocale();
  const formatted = formatRateSummaryValues(rates);

  return (
    <dl className="console-mono grid grid-cols-4 gap-1.5 text-[11px]">
      <div>
        <dt className="text-[var(--console-muted)]">{t("In")}</dt>
        <dd className="font-medium text-[var(--console-text)]">{formatted.input}</dd>
      </div>
      <div>
        <dt className="text-[var(--console-muted)]">{t("Out")}</dt>
        <dd className="font-medium text-[var(--console-text)]">{formatted.output}</dd>
      </div>
      <div>
        <dt className="text-[var(--console-muted)]">{t("CR")}</dt>
        <dd className="font-medium text-[var(--console-text)]">{formatted.cacheRead}</dd>
      </div>
      <div>
        <dt className="text-[var(--console-muted)]">{t("CW")}</dt>
        <dd className="font-medium text-[var(--console-text)]">{formatted.cacheWrite}</dd>
      </div>
    </dl>
  );
}

export function PricingOverridesTab({
  overrides,
  pendingModel,
  onSave,
  onAcknowledge,
  onDelete,
}: PricingOverridesTabProps) {
  useLocale();

  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ modelKey: string; message: string } | null>(
    null,
  );
  const sorted = sortOverridesByAttention(overrides);

  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={<Receipt className="size-5" aria-hidden="true" />}
        title={t("No custom pricing overrides yet")}
      />
    );
  }

  const runCardAction = async (modelKey: string, action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError({
        modelKey,
        message: error instanceof Error ? error.message : t("Pricing action failed."),
      });
    }
  };

  return (
    <div className="space-y-2.5">
      {sorted.map((item) => {
        const isEditing = editingModel === item.modelKey;
        const busy = pendingModel === item.modelKey || pendingModel === item.displayModel;
        const cardError = actionError?.modelKey === item.modelKey ? actionError.message : null;
        const cardBorderClass = item.officialPriceAvailable
          ? "border-[var(--console-warning-border)]"
          : item.targetMissing
            ? "border-[var(--console-error-border)]"
            : "border-[var(--console-border)]";

        return (
          <section
            key={item.modelKey}
            className={`rounded-lg border bg-[var(--console-surface)] p-3 ${cardBorderClass}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="console-mono break-all text-xs font-medium text-[var(--console-text)]">
                  {item.displayModel}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-0.5 font-medium text-[var(--console-text-secondary)]">
                    {item.kind === "remap" ? t("Remap") : t("Manual USD / 1M")}
                  </span>
                  {item.kind === "remap" && item.targetModel ? (
                    <span className="console-mono truncate text-[var(--console-muted)]">
                      {`→ ${item.targetModel}`}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditingModel(isEditing ? null : item.modelKey)}
                  className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
                >
                  {isEditing ? t("Close") : t("Edit")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void runCardAction(item.modelKey, () => onDelete(item.modelKey));
                  }}
                  className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-xs font-medium text-[var(--console-muted)] hover:border-[var(--console-error-border)] hover:bg-[var(--console-error-bg)] hover:text-[var(--console-error)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
                >
                  {t("Remove")}
                </button>
              </div>
            </div>

            {item.officialPriceAvailable ? (
              <div className="mt-2.5 space-y-2 rounded-md border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] p-2.5">
                <p className="text-xs font-medium text-[var(--console-warning)]">
                  {t("Official pricing is now available. Your custom rule is still active.")}
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-2">
                    <p className="mb-1 text-[11px] font-medium text-[var(--console-text-secondary)]">
                      {t("Your rule")}
                    </p>
                    {item.effectiveRates ? (
                      <RateStrip rates={item.effectiveRates} />
                    ) : (
                      <p className="text-[11px] text-[var(--console-muted)]">{t("Unavailable")}</p>
                    )}
                  </div>
                  <div className="rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-surface)] p-2">
                    <p className="mb-1 text-[11px] font-medium text-[var(--console-warning)]">
                      {t("Official price")}
                    </p>
                    {item.officialRates ? (
                      <RateStrip rates={item.officialRates} />
                    ) : (
                      <p className="text-[11px] text-[var(--console-muted)]">{t("Unavailable")}</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void runCardAction(item.modelKey, () => onDelete(item.modelKey));
                    }}
                    className="rounded-sm bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-hover)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
                  >
                    {t("Use official price")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void runCardAction(item.modelKey, () => onAcknowledge(item.modelKey));
                    }}
                    className="rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-surface)] px-2.5 py-1 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
                  >
                    {t("Keep custom rule")}
                  </button>
                </div>
              </div>
            ) : item.targetMissing ? (
              <p
                role="alert"
                className="mt-2.5 rounded-md border border-[var(--console-error-border)] bg-[var(--console-error-bg)] px-2.5 py-1.5 text-xs text-[var(--console-error)]"
              >
                {t("Target official model {0} is missing. Edit or remove this rule.", [
                  item.targetModel ?? item.displayModel,
                ])}
              </p>
            ) : item.effectiveRates ? (
              <div className="mt-2.5 rounded-md bg-[var(--console-surface-muted)] px-2.5 py-1.5">
                <RateStrip rates={item.effectiveRates} />
              </div>
            ) : null}

            {cardError ? (
              <p
                role="alert"
                className="mt-2 rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] px-2.5 py-1.5 text-xs text-[var(--console-error)]"
              >
                {cardError}
              </p>
            ) : null}

            {isEditing ? (
              <PricingRuleEditor
                model={item.displayModel}
                initialKind={item.kind}
                initialTargetModel={item.targetModel}
                initialRates={item.kind === "manual" ? item.effectiveRates : null}
                saving={busy}
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
