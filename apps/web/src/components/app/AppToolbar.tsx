import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
declare const __APP_VERSION__: string;

import type { Ref } from "react";
import { Link } from "react-router-dom";
import type { Theme } from "../../hooks/useUiPreferences";
import type { TimeWindow, TimeWindowPreset } from "../../lib/time-window";
import { TimeWindowControl } from "../TimeWindowControl";
import { SearchControls, type SearchControlsHandle } from "./SearchControls";
import { LanguageControl } from "./LanguageControl";
import { ThemeToggle } from "./ThemeToggle";

export interface AppToolbarProps {
  searchControlsRef: Ref<SearchControlsHandle>;
  onSubmitSearch: (query: string) => void;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  onShowShortcuts: () => void;
  timeWindow: {
    value: TimeWindow;
    preset: TimeWindowPreset;
    customFrom?: string;
    customTo?: string;
    onSelectPreset: (preset: TimeWindowPreset) => void;
    onSelectCustom: (from: string, to: string) => void;
  } | null;
}

export function AppToolbar({
  searchControlsRef,
  onSubmitSearch,
  theme,
  onChangeTheme,
  onShowShortcuts,
  timeWindow,
}: AppToolbarProps) {
  useLocale();

  return (
    <header className="shrink-0 border-b border-[var(--console-border)] bg-[var(--console-surface)]/85 backdrop-blur-sm">
      <div className="grid min-h-14 grid-cols-[auto_1fr] items-center gap-3 px-4 py-2 sm:grid-cols-[auto_1fr_auto] sm:py-0">
        <div className="flex items-center gap-2">
          <Link to="/" className="flex items-center gap-2 text-[var(--console-text)]">
            <img src="/logo.svg?v=3" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
            <span className="console-display text-sm font-semibold uppercase tracking-[0.05em]">
              CodeSesh
            </span>
          </Link>
        </div>
        <SearchControls ref={searchControlsRef} onSubmit={onSubmitSearch} />
        <div className="flex items-center flex-wrap justify-end gap-2">
          <LanguageControl />
          <ThemeToggle theme={theme} onChange={onChangeTheme} />
          <button
            type="button"
            onClick={onShowShortcuts}
            className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
            title={t("Show keyboard shortcuts")}
          >
            ?<span className="hidden sm:inline"> {t("Shortcuts")}</span>
          </button>
          {timeWindow ? (
            <TimeWindowControl
              window={timeWindow.value}
              preset={timeWindow.preset}
              customFrom={timeWindow.customFrom}
              customTo={timeWindow.customTo}
              onSelectPreset={timeWindow.onSelectPreset}
              onSelectCustom={timeWindow.onSelectCustom}
            />
          ) : null}
          <span className="console-mono hidden rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-xs text-[var(--console-muted)] sm:inline-flex">
            v{__APP_VERSION__}
          </span>
        </div>
      </div>
    </header>
  );
}
