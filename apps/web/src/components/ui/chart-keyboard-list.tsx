import { useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";

function nextItemIndex(key: string, index: number, lastIndex: number): number | null {
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(lastIndex, index + 1);
  if (key === "Home") return 0;
  if (key === "End") return lastIndex;
  return null;
}

export function ChartKeyboardList({
  label,
  itemLabels,
  activeIndex,
  onActiveIndexChange,
  layout,
}: {
  label: string;
  itemLabels: readonly string[];
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
  layout: "columns" | "surface";
}) {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [rovingIndex, setRovingIndex] = useState(0);
  const lastIndex = itemLabels.length - 1;
  const tabIndex = Math.min(rovingIndex, Math.max(0, lastIndex));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onActiveIndexChange(null);
      return;
    }
    const nextIndex = nextItemIndex(event.key, index, lastIndex);
    if (nextIndex === null) return;

    event.preventDefault();
    setRovingIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  return (
    <>
      <div
        role="listbox"
        aria-label={label}
        aria-orientation="horizontal"
        className={cn(
          "pointer-events-none absolute inset-0 z-[1]",
          layout === "columns" ? "flex" : null,
        )}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onActiveIndexChange(null);
        }}
      >
        {itemLabels.map((itemLabel, index) => (
          <div
            key={index}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            role="option"
            aria-label={itemLabel}
            aria-selected={activeIndex === index}
            tabIndex={index === tabIndex ? 0 : -1}
            className={cn(
              "pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--brand)]",
              layout === "columns"
                ? "h-full min-w-0 flex-1 rounded-sm"
                : "absolute inset-0 rounded-full",
            )}
            onFocus={() => {
              setRovingIndex(index);
              onActiveIndexChange(index);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          />
        ))}
      </div>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {activeIndex === null ? "" : itemLabels[activeIndex]}
      </span>
    </>
  );
}
