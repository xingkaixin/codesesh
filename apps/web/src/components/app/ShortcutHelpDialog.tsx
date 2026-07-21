import { Dialog } from "@base-ui/react/dialog";

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
    title: "Search & Help",
    items: [
      { keys: "Cmd/Ctrl K", description: "Open global search" },
      { keys: "/", description: "Focus the search box" },
      { keys: "Esc", description: "Exit search or close the current detail view" },
      { keys: "?", description: "Open this shortcuts panel" },
    ],
  },
] as const;

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="shortcut-overlay fixed inset-0 z-50 bg-black/35" />
        <Dialog.Popup className="shortcut-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl origin-center -translate-x-1/2 -translate-y-1/2 rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] p-5 shadow-2xl outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="console-mono text-[11px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
                Keyboard Shortcuts
              </p>
              <Dialog.Title className="console-mono mt-2 text-xl font-semibold text-[var(--console-text)]">
                Navigate without leaving the keyboard
              </Dialog.Title>
            </div>
            <Dialog.Close className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface)]">
              Esc
            </Dialog.Close>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
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
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
