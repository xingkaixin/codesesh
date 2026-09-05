import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Menu } from "@base-ui/react/menu";
import { Copy, MoreHorizontal, Pencil, Star } from "./ui/icons";
import { useRef } from "react";

export function SessionActionMenuItems({
  bookmarked,
  onCopyAsMarkdown,
  onRename,
  onToggleBookmark,
}: {
  bookmarked: boolean;
  onCopyAsMarkdown?: () => void;
  onRename: () => void;
  onToggleBookmark: () => void;
}) {
  useLocale();

  return (
    <>
      <Menu.Item
        onClick={onRename}
        className="motion-hover motion-press flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
      >
        <Pencil className="size-3" aria-hidden="true" /> {t("Rename")}
      </Menu.Item>
      {onCopyAsMarkdown ? (
        <Menu.Item
          onClick={onCopyAsMarkdown}
          className="motion-hover motion-press flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
        >
          <Copy className="size-3" aria-hidden="true" /> {t("Copy as Markdown")}
        </Menu.Item>
      ) : null}
      <Menu.Item
        onClick={onToggleBookmark}
        className="motion-hover motion-press flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
      >
        <Star className="size-3" fill={bookmarked ? "currentColor" : "none"} aria-hidden="true" />
        {bookmarked ? t("Remove bookmark") : t("Add bookmark")}
      </Menu.Item>
    </>
  );
}

export function SessionActionsMenu({
  bookmarked,
  onCopyAsMarkdown,
  onRename,
  onToggleBookmark,
}: {
  bookmarked: boolean;
  onCopyAsMarkdown?: () => void;
  onRename: () => void;
  onToggleBookmark: () => void;
}) {
  useLocale();

  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        ref={triggerRef}
        aria-label={t("Session options")}
        onClick={(event) => event.stopPropagation()}
        className="motion-hover motion-press inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--console-bg)] focus-visible:outline-none"
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-30">
          <Menu.Popup
            finalFocus={triggerRef}
            className="motion-menu w-36 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-1 shadow-[var(--shadow-overlay)] focus-visible:outline-none"
          >
            <SessionActionMenuItems
              bookmarked={bookmarked}
              onCopyAsMarkdown={onCopyAsMarkdown}
              onRename={onRename}
              onToggleBookmark={onToggleBookmark}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
