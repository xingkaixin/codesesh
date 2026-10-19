import { t } from "../i18n/translate";
import { useLocale } from "../hooks/useLocale";
import type { SmartTag } from "@codesesh/contract";
import { cn } from "../lib/utils";

const CHIP_CLASS =
  "inline-flex h-5 items-center gap-[5px] rounded-md bg-[var(--console-surface-muted)] px-[7px] text-[11px] font-medium whitespace-nowrap text-[var(--console-text-secondary)] shadow-[inset_0_0_0_1px_var(--console-border)]";

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
            className="size-1.5 shrink-0 rounded-[2px]"
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
