import type {
  OfficialModelListResponse,
  PricingOverrideKind,
  PricingRatePerMillion,
  UpsertPricingOverrideRequest,
} from "@codesesh/contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { fetchOfficialPricingModels } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { SegmentedControl } from "../ui/segmented-control";
import { Check, Search } from "../ui/icons";
import { formatRatePerMillion } from "./pricing-format";

const OFFICIAL_MODEL_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 150;
const MAX_RATE_PER_MILLION = 1_000_000;

export interface PricingRuleEditorProps {
  model: string;
  initialKind?: PricingOverrideKind;
  initialTargetModel?: string | null;
  initialRates?: PricingRatePerMillion | null;
  saving: boolean;
  onSave: (request: UpsertPricingOverrideRequest) => Promise<void>;
  onCancel: () => void;
}

function parseRateField(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_RATE_PER_MILLION) {
    return null;
  }
  return parsed;
}

export function PricingRuleEditor({
  model,
  initialKind = "remap",
  initialTargetModel = null,
  initialRates = null,
  saving,
  onSave,
  onCancel,
}: PricingRuleEditorProps) {
  useLocale();

  const fieldBaseId = useId();
  const [mode, setMode] = useState<PricingOverrideKind>(initialKind);
  const [searchQuery, setSearchQuery] = useState(initialTargetModel ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState((initialTargetModel ?? "").trim());
  const [selectedTarget, setSelectedTarget] = useState<string | null>(initialTargetModel);
  const [inputRate, setInputRate] = useState(initialRates ? String(initialRates.input) : "");
  const [outputRate, setOutputRate] = useState(initialRates ? String(initialRates.output) : "");
  const [cacheReadRate, setCacheReadRate] = useState(
    initialRates ? String(initialRates.cacheRead) : "0",
  );
  const [cacheWriteRate, setCacheWriteRate] = useState(
    initialRates ? String(initialRates.cacheWrite) : "0",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    const timer = setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const modelsQuery = useQuery<OfficialModelListResponse>({
    queryKey: queryKeys.pricingModels(debouncedQuery, OFFICIAL_MODEL_LIMIT),
    queryFn: () => fetchOfficialPricingModels(debouncedQuery || undefined, OFFICIAL_MODEL_LIMIT),
    enabled: mode === "remap",
    staleTime: 60_000,
  });

  const handleModeChange = (nextMode: PricingOverrideKind) => {
    setMode(nextMode);
    setErrorMessage(null);
  };

  const fillZeroRates = () => {
    setInputRate("0");
    setOutputRate("0");
    setCacheReadRate("0");
    setCacheWriteRate("0");
    setErrorMessage(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    if (mode === "remap") {
      if (!selectedTarget) {
        setErrorMessage(t("Select an official model first."));
        return;
      }
      try {
        await onSave({
          model,
          kind: "remap",
          targetModel: selectedTarget,
        });
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : t("Failed to save pricing rule."));
      }
      return;
    }

    const input = parseRateField(inputRate);
    const output = parseRateField(outputRate);
    const cacheRead = parseRateField(cacheReadRate);
    const cacheWrite = parseRateField(cacheWriteRate);
    if (input === null || output === null || cacheRead === null || cacheWrite === null) {
      setErrorMessage(t("Enter valid non-negative USD/1M rates."));
      return;
    }

    try {
      await onSave({
        model,
        kind: "manual",
        rates: { input, output, cacheRead, cacheWrite },
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("Failed to save pricing rule."));
    }
  };

  const candidates = modelsQuery.data?.models ?? [];

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="mt-3 space-y-3 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          size="sm"
          ariaLabel={t("Pricing rule mode")}
          value={mode}
          onChange={handleModeChange}
          options={[
            { value: "remap", label: t("Match official model") },
            { value: "manual", label: t("Manual USD / 1M") },
          ]}
        />
        {mode === "manual" ? (
          <button
            type="button"
            onClick={fillZeroRates}
            disabled={saving}
            className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-[11px] font-medium text-[var(--console-text-secondary)] hover:bg-[var(--console-surface-sunken)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
          >
            {t("$0 (Free / Local)")}
          </button>
        ) : null}
      </div>

      {mode === "remap" ? (
        <div className="space-y-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--console-muted)]"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => {
                const next = event.target.value;
                setSearchQuery(next);
                if (!next.trim()) setDebouncedQuery("");
              }}
              placeholder={t("Search official models")}
              aria-label={t("Search official models")}
              className="console-mono w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] py-1.5 pr-2.5 pl-8 text-xs text-[var(--console-text)] placeholder:text-[var(--console-muted)] focus-visible:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand-soft)] focus-visible:outline-none"
            />
          </div>

          <div className="console-scrollbar max-h-52 space-y-1 overflow-y-auto rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1">
            {modelsQuery.isLoading ? (
              <p className="px-2 py-3 text-center text-xs text-[var(--console-muted)]">
                {t("Loading official models...")}
              </p>
            ) : modelsQuery.isError ? (
              <p className="px-2 py-3 text-center text-xs text-[var(--console-error)]">
                {t("Could not load official models.")}
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-[var(--console-muted)]">
                {t("No official models match this search.")}
              </p>
            ) : (
              candidates.map((option) => {
                const selected = selectedTarget === option.model;
                return (
                  <button
                    key={option.model}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setSelectedTarget(option.model);
                      setErrorMessage(null);
                    }}
                    className={`w-full rounded-sm px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
                      selected
                        ? "bg-[var(--brand-soft)] text-[var(--console-text)] shadow-[inset_0_0_0_1px_var(--brand-line)]"
                        : "hover:bg-[var(--console-surface-muted)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="console-mono min-w-0 truncate text-xs font-medium text-[var(--console-text)]">
                        {option.model}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {option.hasLongContext ? (
                          <span className="rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--console-muted)]">
                            {t("Long context")}
                          </span>
                        ) : null}
                        {selected ? (
                          <Check className="size-3.5 text-[var(--brand-ink)]" aria-hidden="true" />
                        ) : null}
                      </div>
                    </div>
                    <div className="console-mono mt-0.5 flex flex-wrap gap-x-2.5 text-[11px] text-[var(--console-muted)]">
                      <span>{`${t("In")} ${formatRatePerMillion(option.rates.input)}`}</span>
                      <span>{`${t("Out")} ${formatRatePerMillion(option.rates.output)}`}</span>
                      <span>{`${t("CR")} ${formatRatePerMillion(option.rates.cacheRead)}`}</span>
                      <span>{`${t("CW")} ${formatRatePerMillion(option.rates.cacheWrite)}`}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label
                htmlFor={`${fieldBaseId}-input`}
                className="mb-1 block text-[11px] font-medium text-[var(--console-text-secondary)]"
              >
                {t("Input (USD / 1M)")}
              </label>
              <input
                id={`${fieldBaseId}-input`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.00"
                value={inputRate}
                onChange={(event) => setInputRate(event.target.value)}
                className="console-mono w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2.5 py-1.5 text-xs text-[var(--console-text)] focus-visible:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand-soft)] focus-visible:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldBaseId}-output`}
                className="mb-1 block text-[11px] font-medium text-[var(--console-text-secondary)]"
              >
                {t("Output (USD / 1M)")}
              </label>
              <input
                id={`${fieldBaseId}-output`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.00"
                value={outputRate}
                onChange={(event) => setOutputRate(event.target.value)}
                className="console-mono w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2.5 py-1.5 text-xs text-[var(--console-text)] focus-visible:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand-soft)] focus-visible:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldBaseId}-cache-read`}
                className="mb-1 block text-[11px] font-medium text-[var(--console-text-secondary)]"
              >
                {t("Cache read (USD / 1M)")}
              </label>
              <input
                id={`${fieldBaseId}-cache-read`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.00"
                value={cacheReadRate}
                onChange={(event) => setCacheReadRate(event.target.value)}
                className="console-mono w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2.5 py-1.5 text-xs text-[var(--console-text)] focus-visible:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand-soft)] focus-visible:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldBaseId}-cache-write`}
                className="mb-1 block text-[11px] font-medium text-[var(--console-text-secondary)]"
              >
                {t("Cache write (USD / 1M)")}
              </label>
              <input
                id={`${fieldBaseId}-cache-write`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0.00"
                value={cacheWriteRate}
                onChange={(event) => setCacheWriteRate(event.target.value)}
                className="console-mono w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2.5 py-1.5 text-xs text-[var(--console-text)] focus-visible:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand-soft)] focus-visible:outline-none"
              />
            </div>
          </div>
          <p className="text-[11px] text-[var(--console-muted)]">
            {t("Reasoning tokens follow the output rate.")}
          </p>
        </div>
      )}

      {errorMessage ? (
        <p
          role="alert"
          className="rounded-sm border border-[var(--console-error-border)] bg-[var(--console-error-bg)] px-2.5 py-1.5 text-xs text-[var(--console-error)]"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-1 text-xs font-medium text-[var(--console-text-secondary)] hover:bg-[var(--console-surface-sunken)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
        >
          {t("Cancel")}
        </button>
        <button
          type="submit"
          disabled={saving || (mode === "remap" && !selectedTarget)}
          className="rounded-sm bg-[var(--brand)] px-3 py-1 text-xs font-medium text-[var(--brand-fg)] hover:bg-[var(--brand-hover)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-surface-muted)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t("Saving...") : t("Save override")}
        </button>
      </div>
    </form>
  );
}
