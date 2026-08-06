/**
 * The redesign segment switcher (overview scope, chart metric, sub-session mode).
 * A `radiogroup` with roving focus: only the selected segment is tabbable and the
 * arrow keys both move focus and change the selection, per WAI-ARIA radio groups.
 */
import { useRef } from "react";
import type * as React from "react";

import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

const SIZE_CLASS = {
  sm: "px-2 py-[3px] text-[10.5px]",
  md: "px-3 py-[5px] text-xs",
} as const;

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const focusIndex = selectedIndex < 0 ? 0 : selectedIndex;

  const move = (from: number, step: number) => {
    const next = (from + step + options.length) % options.length;
    onChange(options[next]!.value);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-[3px]"
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={cn(
              "console-mono motion-hover rounded-sm border border-transparent whitespace-nowrap focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
              SIZE_CLASS[size],
              selected
                ? "bg-[var(--brand)] text-[var(--brand-fg)]"
                : "text-[var(--console-muted)] hover:text-[var(--console-text)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
