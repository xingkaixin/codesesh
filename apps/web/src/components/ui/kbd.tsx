import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] items-center rounded-[4px] border border-b-2 border-[var(--console-border)] bg-[var(--console-surface)] px-[5px] font-sans text-[10px] font-semibold text-[var(--console-muted)]">
      {children}
    </kbd>
  );
}
