import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { formatInt } from "../../lib/format";
import { X } from "../ui/icons";
import type { PricingDrawerTab } from "../pricing/PricingDrawer";

export interface PricingNoticeProps {
  visible: boolean;
  attentionCount: number;
  unmatchedCount: number;
  officialAvailableCount: number;
  unmatchedError?: boolean;
  overridesError?: boolean;
  onRetry?: () => void;
  onOpenPricing: (tab: PricingDrawerTab) => void;
  onDismiss: () => void;
}

export function PricingNotice({
  visible,
  attentionCount,
  unmatchedCount,
  officialAvailableCount,
  unmatchedError = false,
  overridesError = false,
  onRetry,
  onOpenPricing,
  onDismiss,
}: PricingNoticeProps) {
  useLocale();

  const hasError = unmatchedError || overridesError;
  if (!visible || (attentionCount <= 0 && !hasError)) return null;

  let summary: string;
  if (hasError) {
    if (unmatchedError && overridesError) {
      summary = t("Couldn't load model pricing.");
    } else if (unmatchedError) {
      summary = t("Could not count unmatched models");
    } else {
      summary = t("Couldn't load pricing overrides.");
    }
  } else if (unmatchedCount > 0 && officialAvailableCount > 0) {
    summary = t("{0} unmatched · {1} official updates", [
      formatInt(unmatchedCount),
      formatInt(officialAvailableCount),
    ]);
  } else if (officialAvailableCount > 0) {
    summary = t("{0} models now have official pricing", [formatInt(officialAvailableCount)]);
  } else if (unmatchedCount > 0) {
    summary = t("{0} unmatched models missing pricing", [formatInt(unmatchedCount)]);
  } else {
    summary = t("{0} pricing rules need review", [formatInt(attentionCount)]);
  }

  const primaryTab: PricingDrawerTab =
    overridesError && !unmatchedError
      ? "overrides"
      : unmatchedError || unmatchedCount > 0
        ? "unmatched"
        : "overrides";

  return (
    <div
      role={hasError ? "alert" : "status"}
      className={
        hasError
          ? "mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-[10px] bg-[var(--console-error-bg)] px-2.5 py-1.5 text-xs text-[var(--console-error)] shadow-[inset_0_0_0_1px_var(--console-error-border)]"
          : "mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-[10px] bg-[var(--console-warning-bg)] px-2.5 py-1.5 text-xs text-[var(--console-warning)] shadow-[inset_0_0_0_1px_var(--console-warning-border)]"
      }
    >
      <span className="console-mono font-medium">{summary}</span>
      {hasError && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="font-medium underline underline-offset-2 hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          {t("Retry")}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onOpenPricing(primaryTab)}
        className="font-medium underline underline-offset-2 hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Review pricing")}
      </button>
      {!hasError && unmatchedCount > 0 && officialAvailableCount > 0 ? (
        <button
          type="button"
          onClick={() => onOpenPricing("overrides")}
          className="font-medium underline underline-offset-2 hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          {t("View official rates")}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("Dismiss pricing notice")}
        className={
          hasError
            ? "rounded-sm p-0.5 text-[var(--console-error)] hover:bg-[var(--console-surface)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
            : "rounded-sm p-0.5 text-[var(--console-warning)] hover:bg-[var(--console-surface)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        }
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
