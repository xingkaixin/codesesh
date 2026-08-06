/**
 * Tri-state checkbox for the reader's two-level tool filter. A real
 * `<input type="checkbox">` carries the semantics (including `.indeterminate`
 * so assistive tech reports `mixed`); the visible box is an inert sibling.
 */
import { useLayoutEffect, useRef } from "react";

import { Check, Minus } from "./icons";
import { cn } from "../../lib/utils";

export type CheckState = "checked" | "unchecked" | "indeterminate";

export function TriStateCheckbox({
  state,
  onToggle,
  size = 14,
  label,
}: {
  state: CheckState;
  onToggle: () => void;
  size?: 14 | 15;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const indeterminate = state === "indeterminate";

  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <input
        ref={inputRef}
        type="checkbox"
        checked={state === "checked"}
        aria-checked={indeterminate ? "mixed" : state === "checked"}
        aria-label={label}
        onChange={onToggle}
        className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-full items-center justify-center rounded-[4px] border",
          state === "unchecked"
            ? "border-[var(--console-border-strong)] bg-transparent text-transparent"
            : "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]",
        )}
      >
        {indeterminate ? (
          <Minus className="size-2.5 stroke-[3]" />
        ) : state === "checked" ? (
          <Check className="size-2.5 stroke-[3]" />
        ) : null}
      </span>
    </span>
  );
}
