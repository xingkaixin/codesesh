import { t } from "../i18n/translate";
import { useLocale } from "../hooks/useLocale";
import type { SmartTag } from "../lib/api";
import { cn } from "../lib/utils";

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--console-text-secondary)]";

export function SmartTagChips({
  tags,
  limit = 4,
  className = "",
}: {
  tags?: SmartTag[];
  limit?: number;
  className?: string;
}) {
  useLocale();

  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, limit);
  const remaining = tags.length - visible.length;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {visible.map((tag) => (
        <span key={tag} className={CHIP_CLASS}>
          {/* SmartTag values double as the --tag-{tag}-bar color names in index.css. */}
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: `var(--tag-${tag}-bar)` }}
          />
          {t(tag)}
        </span>
      ))}
      {remaining > 0 ? (
        <span className={cn(CHIP_CLASS, "text-[var(--console-muted)]")}>+{remaining}</span>
      ) : null}
    </div>
  );
}
