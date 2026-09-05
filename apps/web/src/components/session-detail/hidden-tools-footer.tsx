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
    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-[15px] py-[11px]">
      <span className="console-mono min-w-0 flex-1 text-[11px] text-[var(--console-muted)]">
        {hiddenCount} {t("hidden by filters")}
        {detail ? ` (${detail})` : ""}
      </span>
      <button
        type="button"
        onClick={onShowAll}
        className="console-mono motion-hover shrink-0 rounded-sm border border-[var(--brand-line)] bg-[var(--brand-soft)] px-2.5 py-[3px] text-[10.5px] text-[var(--brand)] hover:text-[var(--brand-hover)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        {t("Show all")}
      </button>
    </div>
  );
}
