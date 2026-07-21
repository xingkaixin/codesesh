import { Star } from "lucide-react";

interface BookmarkButtonProps {
  active: boolean;
  onToggle: () => void;
  className?: string;
}

export function BookmarkButton({ active, onToggle, className = "" }: BookmarkButtonProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-label={active ? "Remove bookmark" : "Add bookmark"}
      title={active ? "Remove bookmark" : "Add bookmark"}
      className={`motion-hover motion-press inline-flex size-6 shrink-0 items-center justify-center rounded-sm border ${className} ${
        active
          ? "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-text)]"
          : "border-transparent text-[var(--console-muted)] opacity-70 hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] hover:opacity-100"
      }`}
    >
      <Star className="size-3" strokeWidth={1.8} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
