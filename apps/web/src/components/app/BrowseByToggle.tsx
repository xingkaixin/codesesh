import type { BrowseBy } from "./types";

export function BrowseByToggle({
  value,
  onChange,
  projectsDisabled = false,
}: {
  value: BrowseBy;
  onChange: (value: BrowseBy) => void;
  projectsDisabled?: boolean;
}) {
  const options: Array<{ value: BrowseBy; label: string }> = [
    { value: "projects", label: "Projects" },
    { value: "agents", label: "Agents" },
  ];

  return (
    <div role="radiogroup" aria-label="Browse by" className="grid gap-1.5">
      {options.map((option) => {
        const active = value === option.value;
        const disabled = option.value === "projects" && projectsDisabled;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`console-mono flex items-center gap-2 rounded-sm px-3 py-1.5 text-left text-xs motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
              disabled
                ? "cursor-not-allowed text-[var(--console-muted)] opacity-45"
                : active
                  ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                  : "text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)]"
            }`}
            title={
              disabled ? "Project grouping is available after the current scan finishes" : undefined
            }
          >
            <span
              className={`flex size-3 shrink-0 items-center justify-center rounded-full border ${
                active ? "border-[var(--brand)]" : "border-[var(--console-border-strong)]"
              }`}
            >
              {active ? <span className="size-1.5 rounded-full bg-[var(--brand)]" /> : null}
            </span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
