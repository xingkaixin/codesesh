import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Star } from "./ui/icons";

interface BookmarkButtonProps {
  active: boolean;
  onToggle: () => void;
  className?: string;
}

export function BookmarkButton({ active, onToggle, className = "" }: BookmarkButtonProps) {
  useLocale();

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-label={active ? t("Remove bookmark") : t("Add bookmark")}
      title={active ? t("Remove bookmark") : t("Add bookmark")}
      className={`motion-hover motion-press inline-flex size-6 shrink-0 items-center justify-center rounded-sm border focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none ${className} ${
        active
          ? "border-[var(--brand-line)] bg-[var(--brand-soft)] text-[var(--brand)]"
          : "border-transparent text-[var(--console-muted)] opacity-70 hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] hover:opacity-100"
      }`}
    >
      <Star className="size-3" strokeWidth={1.8} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
