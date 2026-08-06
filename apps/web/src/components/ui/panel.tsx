/**
 * The redesign card shell. Every overview / timeline / reader card is a `Panel`
 * so the surface, hairline and elevation are declared exactly once.
 */
import type * as React from "react";

import { cn } from "../../lib/utils";

export function Panel({ className, children, ...rest }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] shadow-[var(--shadow-raised)]",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  meta,
  action,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <h3 className="console-display min-w-0 truncate text-[15px] font-semibold text-[var(--console-text)]">
        {title}
      </h3>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {meta === undefined ? null : (
          <span className="console-mono text-[10.5px] text-[var(--console-muted)]">{meta}</span>
        )}
        {action}
      </div>
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="console-eyebrow">{children}</span>;
}
