import { Dialog } from "@base-ui/react/dialog";
import { useState, type ReactNode } from "react";
import { t } from "../../i18n/translate";
import { X } from "../ui/icons";
import {
  BUTTON_GHOST_CLASS,
  BUTTON_OUTLINE_CLASS,
  BUTTON_PRIMARY_CLASS,
  DIALOG_DESCRIPTION_CLASS,
  DIALOG_TITLE_CLASS,
} from "../ui/dialog-styles";

export const nodeButton = BUTTON_OUTLINE_CLASS;
export const nodePrimary = BUTTON_PRIMARY_CLASS;

export function NodeDialog({
  title,
  description,
  children,
  onClose,
  busy = false,
  wide = false,
  closeRequested = false,
  headerAction,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  closeRequested?: boolean;
  headerAction?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog.Root
      open={open && !closeRequested}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
      onOpenChangeComplete={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-[70] bg-[var(--scrim)]" />
        <Dialog.Popup
          className={`motion-modal console-scrollbar fixed left-1/2 top-1/2 z-[71] max-h-[90dvh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[16px] border border-[var(--console-border)] bg-[var(--console-surface)] px-6 py-5 text-[var(--console-text)] shadow-[var(--shadow-overlay)] focus:outline-none ${wide ? "w-[min(96vw,960px)]" : "w-[min(94vw,480px)]"}`}
        >
          <div className={`flex items-start justify-between gap-4 ${wide ? "flex-wrap" : ""}`}>
            <div className={wide ? "min-w-0" : "min-w-0 flex-1"}>
              <Dialog.Title className={DIALOG_TITLE_CLASS}>{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className={DIALOG_DESCRIPTION_CLASS}>
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {headerAction}
              <Dialog.Close
                disabled={busy}
                aria-label={t("Close")}
                className={`${BUTTON_GHOST_CLASS} w-8 px-0`}
              >
                <X aria-hidden="true" className="size-4" />
              </Dialog.Close>
            </div>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
