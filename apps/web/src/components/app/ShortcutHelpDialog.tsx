const SHORTCUT_GROUPS = [
  {
    title: "Navigation",
    items: [
      { keys: "j / k", description: "Move through sessions or search results" },
      { keys: "Enter", description: "Open the current selection" },
      { keys: "g / G", description: "Jump to the first or last item" },
    ],
  },
  {
    title: "Search",
    items: [
      { keys: "Cmd/Ctrl K", description: "Open global search" },
      { keys: "/", description: "Focus the search box" },
      { keys: "Esc", description: "Exit search or close the current detail view" },
    ],
  },
  {
    title: "Groups",
    items: [
      { keys: "g / G", description: "Jump to the first or last session" },
      { keys: "?", description: "Open this shortcuts panel" },
    ],
  },
] as const;

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-2xl rounded-sm border border-[var(--console-border-strong)] bg-white p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="console-mono text-[11px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
              Keyboard Shortcuts
            </p>
            <h2 className="console-mono mt-2 text-xl font-semibold text-[var(--console-text)]">
              Navigate without leaving the keyboard
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-white"
          >
            Esc
          </button>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {SHORTCUT_GROUPS.map((group) => (
            <div
              key={group.title}
              className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-4"
            >
              <h3 className="console-mono text-xs font-bold uppercase text-[var(--console-text)]">
                {group.title}
              </h3>
              <div className="mt-3 space-y-3">
                {group.items.map((item) => (
                  <div key={item.keys}>
                    <p className="console-mono text-xs text-[var(--console-text)]">{item.keys}</p>
                    <p className="mt-1 text-sm leading-6 text-[var(--console-muted)]">
                      {item.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
