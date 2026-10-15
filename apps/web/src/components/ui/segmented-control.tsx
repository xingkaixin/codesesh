/**
 * The redesign segment switcher (overview scope, chart metric, sub-session mode).
 * A `radiogroup` with roving focus: only the selected segment is tabbable and the
 * arrow keys both move focus and change the selection, per WAI-ARIA radio groups.
 */
import { useRef } from "react";
import type * as React from "react";

import { useFluidHover } from "../../hooks/useFluidHover";

import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

const SIZE_CLASS = {
  sm: "px-2.5 py-[3px] text-[11px]",
  md: "px-3 py-1 text-xs",
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
  const hoverRef = useFluidHover<HTMLDivElement>();
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
      ref={hoverRef}
      data-fluid-hover="x"
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex gap-0.5 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-0.5"
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            data-fluid-item
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
              "motion-hover rounded-md font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
              SIZE_CLASS[size],
              selected
                ? "bg-[var(--console-surface)] text-[var(--console-text)] shadow-[var(--shadow-raised)]"
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
