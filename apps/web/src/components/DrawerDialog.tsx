import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

const VARIANT_STYLES = {
  desktop: {
    backdrop: "z-[60] hidden bg-black/20 min-[1025px]:block",
    popup: "z-[61] hidden w-[min(92vw,430px)] p-4 min-[1025px]:block",
  },
  mobile: {
    backdrop: "z-50 bg-black/30 min-[1025px]:hidden",
    popup: "console-scrollbar z-[51] w-[min(90vw,380px)] overflow-y-auto p-3 min-[1025px]:hidden",
  },
} as const;

export function DrawerDialog({
  open,
  onOpenChange,
  title,
  variant,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  variant: keyof typeof VARIANT_STYLES;
  children: ReactNode;
}) {
  const styles = VARIANT_STYLES[variant];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`fixed inset-0 ${styles.backdrop}`} />
        <Dialog.Popup
          className={`fixed bottom-0 right-0 top-0 overscroll-contain border-l border-[var(--console-border)] bg-[var(--console-bg)] shadow-[-12px_0_32px_rgba(15,23,42,0.18)] outline-none ${styles.popup}`}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="console-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--console-text)]">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={`Close ${title.toLowerCase()}`}
              className="rounded-sm border border-[var(--console-border)] bg-white p-2 text-[var(--console-muted)] transition-colors hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
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
