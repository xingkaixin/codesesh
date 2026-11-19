import type { RefObject } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "../ui/icons";

const NAV_BUTTON_CLASS =
  "motion-hover inline-flex size-6 items-center justify-center rounded text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

interface SessionFindBarProps {
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  activeIndex: number;
  matchCount: number;
  searching: boolean;
  onChangeQuery: (query: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function SessionFindBar({
  query,
  inputRef,
  activeIndex,
  matchCount,
  searching,
  onChangeQuery,
  onPrev,
  onNext,
  onClose,
}: SessionFindBarProps) {
  useLocale();

  const hasQuery = query.trim().length > 0;
  const counterText = matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : "0 / 0";

  return (
    <div
      role="search"
      aria-label={t("Find in session")}
      className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-2.5 py-1.5 shadow-[var(--shadow-raised)]"
    >
      <Search aria-hidden="true" className="size-3.5 shrink-0 text-[var(--console-muted)]" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onChangeQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrev();
            else onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t("Find in session…")}
        aria-label={t("Find in session")}
        className="min-w-[140px] flex-1 bg-transparent text-xs text-[var(--console-text)] placeholder:text-[var(--console-muted)] focus:outline-none"
      />
      {hasQuery ? (
        <span
          aria-live="polite"
          className="console-mono inline-flex items-center gap-1.5 px-1 text-[11px] tabular-nums text-[var(--console-muted)]"
        >
          {searching ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin" /> : null}
          {counterText}
        </span>
      ) : null}
      <div className="flex items-center gap-0.5 border-l border-[var(--console-border)] pl-1.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={matchCount === 0}
          aria-label={t("Previous match")}
          title={t("Previous match")}
          className={NAV_BUTTON_CLASS}
        >
          <ChevronUp aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={matchCount === 0}
          aria-label={t("Next match")}
          title={t("Next match")}
          className={NAV_BUTTON_CLASS}
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close find")}
          title={t("Close find")}
          className={NAV_BUTTON_CLASS}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
