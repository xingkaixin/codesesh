import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";

/**
 * Closes the stream with an honest account of what the current filter removed,
 * and the single action that undoes it.
 */
export function HiddenToolsFooter({
  hiddenCount,
  hiddenTools,
  onShowAll,
}: {
  hiddenCount: number;
  hiddenTools: Array<{ label: string; count: number }>;
  onShowAll: () => void;
}) {
  useLocale();

  if (hiddenCount <= 0) return null;

  const detail = hiddenTools.map((tool) => `${tool.label} ${tool.count}`).join(" · ");

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-[var(--console-border-strong)] px-4 py-3">
      <span className="min-w-0 flex-1 text-xs text-[var(--console-muted)]">
        {hiddenCount} {t("hidden by filters")}
        {detail ? ` (${detail})` : ""}
      </span>
      <button
        type="button"
        onClick={onShowAll}
        className="motion-hover inline-flex h-6 shrink-0 items-center rounded-lg border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2.5 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Show all")}
      </button>
    </div>
  );
}
