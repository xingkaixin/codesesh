import { MoreHorizontal, Pencil, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function SessionActionsMenu({
  bookmarked,
  onRename,
  onToggleBookmark,
}: {
  bookmarked: boolean;
  onRename: () => void;
  onToggleBookmark: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnFocusOutside = (event: FocusEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("focusin", closeOnFocusOutside);
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("focusin", closeOnFocusOutside);
    };
  }, [open]);

  return (
    <div
      ref={menuRef}
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label="Session options"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        className="inline-flex size-6 items-center justify-center rounded-sm border border-transparent text-[var(--console-muted)] transition-[background-color,border-color,color,transform] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-7 z-30 w-36 rounded-sm border border-[var(--console-border-strong)] bg-white p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] active:scale-[0.97] focus-visible:bg-[var(--console-surface-muted)] focus-visible:outline-none"
          >
            <Pencil className="size-3" aria-hidden="true" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onToggleBookmark();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] active:scale-[0.97] focus-visible:bg-[var(--console-surface-muted)] focus-visible:outline-none"
          >
            <Star
              className="size-3"
              fill={bookmarked ? "currentColor" : "none"}
              aria-hidden="true"
            />
            {bookmarked ? "Remove bookmark" : "Add bookmark"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
