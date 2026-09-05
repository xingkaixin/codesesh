import { useSyncExternalStore } from "react";
import {
  getLanguageSnapshot,
  setLanguagePreference,
  subscribeLanguage,
  type LanguagePreference,
} from "../../i18n/language";
import { t } from "../../i18n/translate";

export function LanguageControl() {
  const { preference } = useSyncExternalStore(
    subscribeLanguage,
    getLanguageSnapshot,
    getLanguageSnapshot,
  );
  return (
    <label className="console-mono flex shrink-0 items-center gap-1 text-xs text-[var(--console-muted)]">
      <span className="sr-only">{t("Language")}</span>
      <select
        value={preference}
        onChange={(event) => setLanguagePreference(event.target.value as LanguagePreference)}
        className="max-w-28 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1.5 py-1 text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
      >
        <option value="system">{t("Follow system")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
      </select>
    </label>
  );
}
