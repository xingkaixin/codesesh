import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import { RenderProfiler } from "../RenderProfiler";

export interface SearchControlsHandle {
  clear(): void;
  focusAndSelect(): void;
}

export const SearchControls = forwardRef<
  SearchControlsHandle,
  { onSubmit: (query: string) => void }
>(function SearchControls({ onSubmit }, ref) {
  const [query, setQuery] = useState("");
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
      <form
        className="order-3 col-span-2 flex w-full items-center justify-center gap-2 sm:order-none sm:col-span-1 sm:mx-auto sm:max-w-[560px]"
        onSubmit={submit}
      >
        <label className="flex min-w-0 flex-1 items-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 focus-within:border-[var(--brand-line)] focus-within:ring-2 focus-within:ring-[var(--brand)]">
          <span className="sr-only">Search Sessions</span>
          <input
            ref={inputRef}
            type="search"
            name="session-search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions…  /"
            className="console-mono w-full min-w-0 bg-transparent text-xs text-[var(--console-text)] outline-none placeholder:text-[var(--console-muted)]"
          />
        </label>
        <button
          type="submit"
          className="console-mono rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface-muted)] px-3 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          Search
        </button>
      </form>
    </RenderProfiler>
  );
});
