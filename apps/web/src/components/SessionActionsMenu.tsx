import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, Pencil, Star } from "lucide-react";
import { useRef } from "react";

export function SessionActionsMenu({
  bookmarked,
  onRename,
  onToggleBookmark,
}: {
  bookmarked: boolean;
  onRename: () => void;
  onToggleBookmark: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        ref={triggerRef}
        aria-label="Session options"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-transparent text-[var(--console-muted)] transition-[background-color,border-color,color,transform] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-30">
          <Menu.Popup
            finalFocus={triggerRef}
            className="w-36 rounded-sm border border-[var(--console-border-strong)] bg-white p-1 shadow-lg focus-visible:outline-none"
          >
            <Menu.Item
              onClick={onRename}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] active:scale-[0.97] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
            >
              <Pencil className="size-3" aria-hidden="true" />
              Rename
            </Menu.Item>
            <Menu.Item
              onClick={onToggleBookmark}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] active:scale-[0.97] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
            >
              <Star
                className="size-3"
                fill={bookmarked ? "currentColor" : "none"}
                aria-hidden="true"
              />
              {bookmarked ? "Remove bookmark" : "Add bookmark"}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
