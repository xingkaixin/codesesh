import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import type { ModelPricingState } from "../../hooks/useModelPricing";
import { t } from "../../i18n/translate";
import type { AgentCatalog } from "../../lib/agents";
import { formatInt } from "../../lib/format";
import { DrawerDialog } from "../DrawerDialog";
import { EmptyState } from "../ui/empty-state";
import { XCircle } from "../ui/icons";
import { PricingOverridesTab } from "./PricingOverridesTab";
import { PricingUnmatchedTab } from "./PricingUnmatchedTab";

export type PricingDrawerTab = "unmatched" | "overrides";

export interface PricingDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab: PricingDrawerTab;
  agentCatalog: AgentCatalog;
  pricing: ModelPricingState;
}

export function PricingDrawer({
  open,
  onOpenChange,
  initialTab,
  agentCatalog,
  pricing,
}: PricingDrawerProps) {
  useLocale();

  const [activeTab, setActiveTab] = useState<PricingDrawerTab>(initialTab);
  const wasOpenRef = useRef(open);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setActiveTab(initialTab);
    }
    wasOpenRef.current = open;
  }, [initialTab, open]);

  const unmatchedModels = pricing.overview?.unmatchedModels ?? [];
  const overrides = pricing.overview?.overrides ?? [];
  const overrideAttentionCount = overrides.filter(
    (item) => item.officialPriceAvailable || item.targetMissing,
  ).length;

  return (
    <DrawerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("Model pricing")}
      variant="panel"
      side="right"
    >
      <div
        role="tablist"
        aria-label={t("Pricing sections")}
        className="mb-3 grid grid-cols-2 gap-1 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "unmatched"}
          onClick={() => setActiveTab("unmatched")}
          className={`flex items-center justify-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
            activeTab === "unmatched"
              ? "bg-[var(--console-surface)] text-[var(--console-text)] shadow-xs"
              : "text-[var(--console-muted)] hover:text-[var(--console-text)]"
          }`}
        >
          <span>{t("Unmatched")}</span>
          <span className="console-mono rounded-full bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--console-text-secondary)]">
            {formatInt(unmatchedModels.length)}
          </span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "overrides"}
          onClick={() => setActiveTab("overrides")}
          className={`flex items-center justify-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
            activeTab === "overrides"
              ? "bg-[var(--console-surface)] text-[var(--console-text)] shadow-xs"
              : "text-[var(--console-muted)] hover:text-[var(--console-text)]"
          }`}
        >
          <span>{t("Overrides")}</span>
          <span className="console-mono rounded-full bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--console-text-secondary)]">
            {formatInt(overrides.length)}
          </span>
          {overrideAttentionCount > 0 ? (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-[var(--console-warning)]"
            />
          ) : null}
        </button>
      </div>

      {pricing.isLoading && !pricing.overview ? (
        <div className="space-y-2.5">
          <div className="h-24 animate-pulse rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)]" />
          <div className="h-24 animate-pulse rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)]" />
        </div>
      ) : pricing.isError && !pricing.overview ? (
        <EmptyState
          tone="error"
          icon={<XCircle className="size-5" aria-hidden="true" />}
          title={t("Could not load model pricing")}
        >
          <button
            type="button"
            onClick={() => {
              void pricing.refetch();
            }}
            className="mt-1 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-1 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            {t("Retry")}
          </button>
        </EmptyState>
      ) : activeTab === "unmatched" ? (
        <PricingUnmatchedTab
          unmatchedModels={unmatchedModels}
          agentCatalog={agentCatalog}
          savingModel={pricing.pendingModel}
          onSave={async (request) => {
            await pricing.saveOverride(request);
          }}
        />
      ) : (
        <PricingOverridesTab
          overrides={overrides}
          pendingModel={pricing.pendingModel}
          onSave={async (request) => {
            await pricing.saveOverride(request);
          }}
          onAcknowledge={async (model) => {
            await pricing.acknowledgeOfficial(model);
          }}
          onDelete={async (model) => {
            await pricing.deleteOverride(model);
          }}
        />
      )}
    </DrawerDialog>
  );
}
