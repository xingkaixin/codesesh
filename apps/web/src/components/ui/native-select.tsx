import type { ComponentProps } from "react";
import { ChevronDown } from "./icons";
import { cn } from "../../lib/utils";

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative inline-flex min-w-0 max-w-full">
      <select
        {...props}
        className={cn(
          "max-w-full appearance-none truncate rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] py-1.5 pr-8 pl-3 text-sm text-[var(--console-text)] hover:border-[var(--console-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
          className,
        )}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-[var(--console-muted)]"
      />
    </span>
  );
}
