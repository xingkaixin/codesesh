import { Dialog } from "@base-ui/react/dialog";
import { useState, type ReactNode } from "react";
import { t } from "../../i18n/translate";
import { cn } from "../../lib/utils";
import { X } from "../ui/icons";

export const nodeButton =
  "motion-hover motion-press inline-flex items-center justify-center gap-2 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2 text-xs font-medium text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50";
export const nodePrimary = cn(
  nodeButton,
  "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)] hover:bg-[var(--brand-hover)]",
);

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
  description: string;
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
          className={`motion-modal console-scrollbar fixed left-1/2 top-1/2 z-[71] max-h-[90dvh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--console-border)] bg-[var(--console-bg)] p-5 text-[var(--console-text)] shadow-[var(--shadow-drawer)] focus:outline-none sm:p-7 ${wide ? "w-[min(96vw,960px)]" : "w-[min(94vw,480px)]"}`}
        >
          <div className={`flex items-start justify-between gap-4 ${wide ? "flex-wrap" : ""}`}>
            <div className={wide ? "min-w-0" : "min-w-0 flex-1"}>
              <Dialog.Title className="console-display text-xl font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-1.5 text-sm text-[var(--console-muted)]">
                {description}
              </Dialog.Description>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {headerAction}
              <Dialog.Close disabled={busy} aria-label={t("Close")} className={nodeButton}>
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
