import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "./ui/icons";

const VARIANT_STYLES = {
  desktop: {
    backdrop: "z-[60] hidden bg-[var(--scrim)] min-[1025px]:block",
    popup: "z-[61] hidden w-[min(92vw,430px)] p-4 min-[1025px]:block",
  },
  mobile: {
    backdrop: "z-50 bg-[var(--scrim)] min-[1025px]:hidden",
    popup: "console-scrollbar z-[51] w-[min(90vw,380px)] overflow-y-auto p-3 min-[1025px]:hidden",
  },
} as const;

const SIDE_STYLES = {
  left: "left-0 border-r",
  right: "right-0 border-l",
} as const;

export function DrawerDialog({
  open,
  onOpenChange,
  title,
  variant,
  side = "right",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  variant: keyof typeof VARIANT_STYLES;
  side?: keyof typeof SIDE_STYLES;
  children: ReactNode;
}) {
  useLocale();

  const styles = VARIANT_STYLES[variant];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`motion-backdrop fixed inset-0 ${styles.backdrop}`} />
        <Dialog.Popup
          data-drawer-side={side}
          className={`motion-drawer fixed bottom-0 top-0 overscroll-contain border-[var(--console-border)] bg-[var(--console-bg)] shadow-[var(--shadow-drawer)] outline-none ${SIDE_STYLES[side]} ${styles.popup}`}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={t("Close {0}", [title.toLowerCase()])}
              className="motion-hover motion-press rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-2 text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
            >
              <X className="size-4" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
