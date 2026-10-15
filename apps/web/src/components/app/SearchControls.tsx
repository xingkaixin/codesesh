import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import { RenderProfiler } from "../RenderProfiler";
import { Search } from "../ui/icons";

export interface SearchControlsHandle {
  clear(): void;
  focusAndSelect(): void;
}

export const SearchControls = forwardRef<
  SearchControlsHandle,
  { onSubmit: (query: string) => void; initialQuery?: string; autoFocus?: boolean }
>(function SearchControls({ onSubmit, initialQuery = "", autoFocus = false }, ref) {
  useLocale();

  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      clear() {
        setQuery("");
      },
      focusAndSelect() {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }),
    [],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(query);
  };

  return (
    <RenderProfiler id="SearchControls">
      <form role="search" className="min-w-0 flex-[1_1_360px]" onSubmit={submit}>
        <label className="flex h-11 min-w-0 items-center gap-2.5 rounded-full border border-[var(--console-border)] bg-[var(--console-surface)] pr-2 pl-3.5 shadow-[var(--shadow-raised)] motion-hover focus-within:border-[var(--brand)] focus-within:ring-3 focus-within:ring-[var(--brand)]/15">
          <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--console-muted)]" />
          <span className="sr-only">{t("Search Sessions")}</span>
          <input
            ref={inputRef}
            type="search"
            name="session-search"
            autoComplete="off"
            autoFocus={autoFocus}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search sessions…")}
            className="w-full min-w-0 bg-transparent text-sm text-[var(--console-text)] outline-none placeholder:text-[var(--console-muted)]"
          />
          <button
            type="submit"
            className="inline-flex h-[22px] shrink-0 items-center rounded-[4px] border border-b-2 border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 text-[10px] font-semibold text-[var(--console-muted)] motion-hover hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            <span aria-hidden="true">Enter</span>
            <span className="sr-only">{t("Search")}</span>
          </button>
        </label>
      </form>
    </RenderProfiler>
  );
});
