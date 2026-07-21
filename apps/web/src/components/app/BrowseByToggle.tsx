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
            className={`console-mono flex items-center gap-2 rounded-sm border px-3 py-1.5 text-left text-xs transition-colors ${
              disabled
                ? "cursor-not-allowed border-transparent text-[var(--console-muted)] opacity-45"
                : active
                  ? "border-[var(--console-border-strong)] bg-[var(--console-surface)] text-[var(--console-text)]"
                  : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
            }`}
            title={
              disabled ? "Project grouping is available after the current scan finishes" : undefined
            }
          >
            <span
              className={`flex size-3 shrink-0 items-center justify-center rounded-full border ${
                active ? "border-[var(--console-accent)]" : "border-[var(--console-border-strong)]"
              }`}
            >
              {active ? (
                <span className="size-1.5 rounded-full bg-[var(--console-accent)]" />
              ) : null}
            </span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
