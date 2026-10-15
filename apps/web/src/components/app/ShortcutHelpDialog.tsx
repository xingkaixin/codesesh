import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { Dialog } from "@base-ui/react/dialog";
import { Fragment } from "react";
import { Kbd } from "../ui/kbd";
import {
  BUTTON_GHOST_CLASS,
  DIALOG_BODY_CLASS,
  DIALOG_HEADER_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_TITLE_CLASS,
} from "../ui/dialog-styles";

const SHORTCUT_GROUPS = [
  {
    title: "Navigation",
    items: [
      { keys: ["J", "K"], description: "Move through sessions or search results" },
      { keys: ["Enter"], description: "Open the current selection" },
      { keys: ["G", "⇧ G"], description: "Jump to the first or last item" },
    ],
  },
  {
    title: "Search & Help",
    items: [
      { keys: ["⌘ K"], description: "Open global search" },
      { keys: ["/"], description: "Focus the search box" },
      { keys: ["Esc"], description: "Exit search or close the current detail view" },
      { keys: ["?"], description: "Open this shortcuts panel" },
    ],
  },
] as const;

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useLocale();

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-50 bg-[var(--scrim)]" />
        <Dialog.Popup className={`${DIALOG_POPUP_CLASS} max-w-[720px]`}>
          <div className={DIALOG_HEADER_CLASS}>
            <div>
              <p className="console-eyebrow">{t("Keyboard Shortcuts")}</p>
              <Dialog.Title className={`${DIALOG_TITLE_CLASS} mt-1`}>
                {t("Navigate without leaving the keyboard")}
              </Dialog.Title>
            </div>
            <Dialog.Close aria-label={t("Close")} className={BUTTON_GHOST_CLASS}>
              <Kbd>Esc</Kbd>
              {t("Close")}
            </Dialog.Close>
          </div>
          <div className={`${DIALOG_BODY_CLASS} pb-6`}>
            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
              {SHORTCUT_GROUPS.map((group) => (
                <section key={group.title}>
                  <h3 className="mb-1 text-xs font-medium text-[var(--console-muted)]">
                    {t(group.title)}
                  </h3>
                  {group.items.map((item) => (
                    <div
                      key={item.description}
                      className="flex items-center justify-between gap-4 border-b border-[var(--console-border)] py-2.5 text-[13px] text-[var(--console-text-secondary)] last:border-b-0"
                    >
                      <span>{t(item.description)}</span>
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--console-muted)]">
                        {item.keys.map((key, index) => (
                          <Fragment key={key}>
                            {index > 0 ? "/" : null}
                            <Kbd>{key}</Kbd>
                          </Fragment>
                        ))}
                      </span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
