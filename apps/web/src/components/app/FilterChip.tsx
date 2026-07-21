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
      className={`console-mono rounded-sm border px-2 py-1 text-[10px] motion-hover ${
        active
          ? "border-[var(--console-border-strong)] bg-[var(--console-accent)] text-white"
          : "border-[var(--console-border)] bg-[var(--console-surface-muted)] text-[var(--console-muted)] hover:bg-[var(--console-surface)]"
      }`}
    >
      {label}
    </button>
  );
}
