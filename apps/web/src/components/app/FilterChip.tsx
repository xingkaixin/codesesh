import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function FilterChip({
  active,
  mono = false,
  onClick,
  children,
}: {
  active: boolean;
  mono?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] whitespace-nowrap motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
        mono && "console-mono",
        active
          ? "border-[var(--brand-line)] bg-[var(--brand-soft)] text-[var(--brand)]"
          : "border-[var(--console-border-strong)] bg-[var(--console-surface)] text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]",
      )}
    >
      {children}
    </button>
  );
}
