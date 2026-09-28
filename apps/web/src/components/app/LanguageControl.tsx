import { useSyncExternalStore } from "react";
import {
  getLanguageSnapshot,
  setLanguagePreference,
  subscribeLanguage,
  type LanguagePreference,
} from "../../i18n/language";
import { Languages } from "../ui/icons";
import { t } from "../../i18n/translate";

export function LanguageControl() {
  const { preference } = useSyncExternalStore(
    subscribeLanguage,
    getLanguageSnapshot,
    getLanguageSnapshot,
  );
  return (
    <label
      title={`${t("Language")}: ${preference === "system" ? t("Follow system") : { "zh-CN": "简体中文", en: "English", ja: "日本語" }[preference]}`}
      className="relative flex shrink-0 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1.5 text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-within:ring-2 focus-within:ring-[var(--brand)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--console-bg)]"
    >
      <span className="sr-only">{t("Language")}</span>
      <Languages aria-hidden="true" className="size-4" />
      <select
        value={preference}
        onChange={(event) => setLanguagePreference(event.target.value as LanguagePreference)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      >
        <option value="system">{t("Follow system")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
      </select>
    </label>
  );
}
