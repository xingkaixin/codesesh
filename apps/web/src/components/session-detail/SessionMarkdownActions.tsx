import type { SessionDetail } from "@codesesh/contract";
import { useCopySessionAsMarkdown } from "../../hooks/useCopySessionAsMarkdown";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { Copy, Download, LoaderCircle } from "../ui/icons";

const ACTION_BUTTON_CLASS =
  "motion-hover motion-press inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 text-xs font-medium text-[var(--console-text-secondary)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export function SessionMarkdownActions({ session }: { session: SessionDetail }) {
  useLocale();

  const {
    copySessionAsMarkdown,
    downloadSessionAsMarkdown,
    isCopying,
    isDownloading,
    sessionCopyNotice,
  } = useCopySessionAsMarkdown();

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {sessionCopyNotice ? (
        <span role="status" aria-live="polite" className="text-xs text-[var(--console-muted)]">
          {sessionCopyNotice}
        </span>
      ) : null}
      <button
        type="button"
        disabled={isCopying}
        onClick={() => void copySessionAsMarkdown(session)}
        className={ACTION_BUTTON_CLASS}
      >
        {isCopying ? (
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none text-[var(--console-muted)]"
            aria-hidden="true"
          />
        ) : (
          <Copy className="size-3.5 text-[var(--console-muted)]" aria-hidden="true" />
        )}
        {isCopying ? t("Copying…") : t("Copy as Markdown")}
      </button>
      <button
        type="button"
        disabled={isDownloading}
        onClick={() => void downloadSessionAsMarkdown(session)}
        className={ACTION_BUTTON_CLASS}
      >
        {isDownloading ? (
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none text-[var(--console-muted)]"
            aria-hidden="true"
          />
        ) : (
          <Download className="size-3.5 text-[var(--console-muted)]" aria-hidden="true" />
        )}
        {isDownloading ? t("Downloading…") : t("Download .md")}
      </button>
    </div>
  );
}
