import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Animates open with a grid-rows 0fr -> 1fr + opacity transition. Closing is
 * instant: content unmounts immediately so heavy children (e.g. full
 * thinking text) never stay rendered while collapsed, matching the previous
 * `{open && children}` lazy-render semantics. `children` is a render prop so
 * the caller's JSX isn't evaluated at all while closed.
 */
export function Collapsible({
  open,
  children,
  className,
}: {
  open: boolean;
  children: () => ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("motion-collapsible", className)} data-open={open || undefined}>
      <div className="motion-collapsible-inner">{open ? children() : null}</div>
    </div>
  );
}
