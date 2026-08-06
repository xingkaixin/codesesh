export function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`console-mono rounded-full border px-2.5 py-1 text-[10px] motion-hover focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none ${
        active
          ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
          : "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:bg-[var(--console-surface)] hover:text-[var(--console-text)]"
      }`}
    >
      {label}
    </button>
  );
}
