import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { CopyResumeButton } from "../CopyResumeButton";
import { SessionActionMenuItems } from "../SessionActionsMenu";
import { Bookmark, MoreHorizontal } from "../ui/icons";

const ICON_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md text-[var(--console-muted)] motion-hover hover:bg-[var(--console-sidebar-accent)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none";

export function SessionHeaderActions({
  back,
  bookmarked,
  onToggleBookmark,
  onRename,
  onCopyAsMarkdown,
  resume,
  resumeDescriptionId,
}: {
  back: { to: string; label: string } | null;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  onRename: () => void;
  onCopyAsMarkdown: () => void;
  resume: { resumeCommandPrefix: string | null; sessionId: string; directory?: string | null };
  resumeDescriptionId: string;
}) {
  useLocale();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {back ? (
        <Link
          to={back.to}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-sidebar-accent)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          <kbd
            aria-hidden
            className="hidden h-[18px] items-center rounded-[4px] border border-b-2 border-[var(--console-border)] bg-[var(--console-surface)] px-[5px] text-[10px] font-semibold text-[var(--console-muted)] sm:inline-flex"
          >
            Esc
          </kbd>
          {back.label}
        </Link>
      ) : null}
      <button
        type="button"
        aria-pressed={bookmarked}
        aria-label={bookmarked ? t("Remove bookmark") : t("Add bookmark")}
        title={bookmarked ? t("Remove bookmark") : t("Add bookmark")}
        onClick={onToggleBookmark}
        className={ICON_BUTTON_CLASS}
      >
        <Bookmark
          aria-hidden="true"
          className={bookmarked ? "size-4 text-[var(--brand)]" : "size-4"}
          fill={bookmarked ? "currentColor" : "none"}
        />
      </button>
      <Menu.Root modal={false}>
        <Menu.Trigger
          ref={menuTriggerRef}
          aria-label={t("Session options")}
          className={ICON_BUTTON_CLASS}
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-30">
            <Menu.Popup
              finalFocus={menuTriggerRef}
              className="motion-menu w-52 rounded-lg border border-[var(--console-border)] bg-[var(--console-bg)] p-1.5 shadow-[var(--shadow-overlay)] focus-visible:outline-none"
            >
              <div className="px-2 pt-1.5 pb-1 text-[11px] text-[var(--console-muted)]">
                {t("Session options")}
              </div>
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
      <CopyResumeButton key={resume.sessionId} {...resume} descriptionId={resumeDescriptionId} />
    </>
  );
}
