import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "../../hooks/useLocale";
import type { ModelPricingState, UnmatchedPricing } from "../../hooks/useModelPricing";
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
  scopeLabel: string | null;
  sessionCount: number;
}

const ELAPSED_VISIBLE_AFTER_SECONDS = 2;

function useElapsedSeconds(): number {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.floor((now - startedAt) / 1000);
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CountingDots() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex animate-pulse gap-0.5 motion-reduce:animate-none"
    >
      <span className="size-[3px] rounded-full bg-current" />
      <span className="size-[3px] rounded-full bg-current" />
      <span className="size-[3px] rounded-full bg-current" />
    </span>
  );
}

function IndeterminateBar() {
  return (
    <span
      aria-hidden="true"
      className="relative block h-0.5 flex-1 overflow-hidden rounded-full bg-[var(--console-surface-muted)]"
    >
      <span className="absolute inset-0 animate-pulse rounded-full bg-[var(--brand-line)] motion-reduce:animate-none" />
    </span>
  );
}

function TabCount({
  state,
  value,
  refreshing = false,
}: {
  state: "pending" | "error" | "ready";
  value: number;
  refreshing?: boolean;
}) {
  if (state === "pending") {
    return (
      <span
        role="img"
        aria-label={t("Counting")}
        className="console-mono inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full bg-[var(--console-surface-muted)] px-1.5 text-[var(--console-muted)]"
      >
        <CountingDots />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span
        role="img"
        aria-label={t("Count failed")}
        className="console-mono inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full bg-[var(--console-error-bg)] px-1.5 text-[11px] text-[var(--console-error)]"
      >
        !
      </span>
    );
  }
  return (
    <span className="console-mono inline-flex items-center gap-1 rounded-full bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--console-text-secondary)]">
      {formatInt(value)}
      {refreshing ? (
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-full bg-[var(--brand)] motion-reduce:animate-none"
        />
      ) : null}
    </span>
  );
}

function TabButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex items-center justify-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
        selected
          ? "bg-[var(--console-surface)] text-[var(--console-text)] shadow-xs"
          : "text-[var(--console-muted)] hover:text-[var(--console-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function SkeletonCards({ count }: { count: number }) {
  return (
    <div aria-hidden="true" className="space-y-2.5 opacity-70">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-lg border border-dashed border-[var(--console-border-strong)] p-3 motion-reduce:animate-none"
        >
          <div className="h-3 w-1/2 rounded-sm bg-[var(--console-surface-muted)]" />
          <div className="mt-2 h-4 w-1/3 rounded-full bg-[var(--console-surface-muted)]" />
          <div className="mt-2.5 h-8 rounded-md bg-[var(--console-surface-muted)]" />
        </div>
      ))}
    </div>
  );
}

function UnmatchedCountingPanel({
  scopeLabel,
  sessionCount,
  overrideCount,
  onShowOverrides,
}: {
  scopeLabel: string | null;
  sessionCount: number;
  overrideCount: number | null;
  onShowOverrides: () => void;
}) {
  const elapsed = useElapsedSeconds();
  return (
    <div className="space-y-2.5">
      <div
        role="status"
        className="overflow-hidden rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)]"
      >
        <div className="flex">
          <IndeterminateBar />
        </div>
        <div className="space-y-1.5 p-3">
          <p className="text-[13px] font-semibold text-[var(--console-text)]">
            {t("Counting unmatched models")}
          </p>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--console-muted)]">
            {scopeLabel ? <span>{scopeLabel}</span> : null}
            <span className="console-mono">{t("{0} sessions", [formatInt(sessionCount)])}</span>
            {elapsed >= ELAPSED_VISIBLE_AFTER_SECONDS ? (
              <span className="console-mono">{t("Waited {0}s", [elapsed])}</span>
            ) : null}
          </p>
          {overrideCount ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--console-muted)]">
              <span>{t("{0} pricing rules are active and unaffected.", [overrideCount])}</span>
              <button
                type="button"
                onClick={onShowOverrides}
                className="font-medium text-[var(--brand-ink)] underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
              >
                {t("View rules")}
              </button>
            </p>
          ) : null}
        </div>
      </div>
      <SkeletonCards count={2} />
    </div>
  );
}

function LoadError({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      role="alert"
      tone="error"
      icon={<XCircle className="size-5" aria-hidden="true" />}
      title={title}
    >
      {detail ? <p>{detail}</p> : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-1 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Retry")}
      </button>
    </EmptyState>
  );
}

function UnmatchedPanel({
  unmatched,
  pricing,
  agentCatalog,
  scopeLabel,
  sessionCount,
  onShowOverrides,
}: {
  unmatched: UnmatchedPricing;
  pricing: ModelPricingState;
  agentCatalog: AgentCatalog;
  scopeLabel: string | null;
  sessionCount: number;
  onShowOverrides: () => void;
}) {
  if (unmatched.status === "pending") {
    return (
      <UnmatchedCountingPanel
        scopeLabel={scopeLabel}
        sessionCount={sessionCount}
        overrideCount={pricing.overrides?.length ?? null}
        onShowOverrides={onShowOverrides}
      />
    );
  }
  if (unmatched.status === "error") {
    return (
      <LoadError
        title={t("Could not count unmatched models")}
        detail={t("Pricing rules are unaffected; session costs still use them.")}
        onRetry={pricing.retryUnmatched}
      />
    );
  }
  const countedAt = formatClock(unmatched.updatedAt);
  return (
    <div className="space-y-2.5">
      {unmatched.refreshing ? (
        <div
          role="status"
          className="flex items-center gap-2 text-[11px] text-[var(--console-muted)]"
        >
          <span>{t("Updating · showing results from {0}", [countedAt])}</span>
          <IndeterminateBar />
        </div>
      ) : null}
      <PricingUnmatchedTab
        unmatchedModels={unmatched.models}
        agentCatalog={agentCatalog}
        savingModel={pricing.pendingModel}
        emptySummary={[
          scopeLabel,
          t("{0} sessions", [formatInt(sessionCount)]),
          t("Counted at {0}", [countedAt]),
        ]
          .filter(Boolean)
          .join(" · ")}
        onSave={async (request) => {
          await pricing.saveOverride(request);
        }}
      />
    </div>
  );
}

export function PricingDrawer({
  open,
  onOpenChange,
  initialTab,
  agentCatalog,
  pricing,
  scopeLabel,
  sessionCount,
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

  const { unmatched, overrides } = pricing;
  const overrideAttentionCount = (overrides ?? []).filter(
    (item) => item.officialPriceAvailable || item.targetMissing,
  ).length;
  const overridesState = pricing.overridesError ? "error" : overrides ? "ready" : "pending";

  return (
    <DrawerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("Model pricing")}
      variant="panel"
      side="right"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pricing.refreshStatus === "pending"}
          onClick={pricing.refreshModels}
          className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-1.5 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-60"
        >
          {pricing.refreshStatus === "pending"
            ? t("Checking for updates…")
            : t("Update models and prices")}
        </button>
        <span role="status" className="text-xs text-[var(--console-muted)]">
          {pricing.refreshStatus === "error" && t("Could not update models and prices.")}
          {pricing.refreshStatus === "changed" && t("Models and prices updated.")}
          {pricing.refreshStatus === "unchanged" && t("Models and prices are up to date.")}
          {pricing.historyPhase === "failed" && (
            <span className="block">{t("Could not recalculate session costs.")}</span>
          )}
          {pricing.historyPhase === "repricing" && (
            <span className="block">{t("Recalculating session costs…")}</span>
          )}
        </span>
      </div>
      <div
        role="tablist"
        aria-label={t("Pricing sections")}
        className="mb-3 grid grid-cols-2 gap-1 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-1"
      >
        <TabButton selected={activeTab === "unmatched"} onSelect={() => setActiveTab("unmatched")}>
          <span>{t("Unmatched")}</span>
          <TabCount
            state={unmatched.status}
            value={unmatched.status === "ready" ? unmatched.models.length : 0}
            refreshing={unmatched.status === "ready" && unmatched.refreshing}
          />
        </TabButton>
        <TabButton selected={activeTab === "overrides"} onSelect={() => setActiveTab("overrides")}>
          <span>{t("Overrides")}</span>
          <TabCount state={overridesState} value={overrides?.length ?? 0} />
          {overrideAttentionCount > 0 ? (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-[var(--console-warning)]"
            />
          ) : null}
        </TabButton>
      </div>

      {activeTab === "unmatched" ? (
        <UnmatchedPanel
          unmatched={unmatched}
          pricing={pricing}
          agentCatalog={agentCatalog}
          scopeLabel={scopeLabel}
          sessionCount={sessionCount}
          onShowOverrides={() => setActiveTab("overrides")}
        />
      ) : overridesState === "error" ? (
        <LoadError title={t("Could not load pricing rules")} onRetry={pricing.retryOverrides} />
      ) : overrides ? (
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
      ) : (
        <SkeletonCards count={2} />
      )}
    </DrawerDialog>
  );
}
