import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
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
  useLocale();

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="shortcut-overlay fixed inset-0 z-50 bg-[var(--scrim)]" />
        <Dialog.Popup className="shortcut-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl origin-center -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-5 shadow-[var(--shadow-overlay)] outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="console-eyebrow">{t("Keyboard Shortcuts")}</p>
              <Dialog.Title className="console-display mt-2 text-[19px] font-semibold text-[var(--console-text)]">
                {t("Navigate without leaving the keyboard")}
              </Dialog.Title>
            </div>
            <Dialog.Close className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none">
              Esc
            </Dialog.Close>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {SHORTCUT_GROUPS.map((group) => (
              <div
                key={t(group.title)}
                className="rounded-md border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-4"
              >
                <h3 className="console-eyebrow">{t(group.title)}</h3>
                <div className="mt-3 space-y-3">
                  {group.items.map((item) => (
                    <div key={item.keys}>
                      <p className="console-mono text-xs text-[var(--console-text)]">{item.keys}</p>
                      <p className="mt-1 text-[13px] leading-6 text-[var(--console-text-secondary)]">
                        {t(item.description)}
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
