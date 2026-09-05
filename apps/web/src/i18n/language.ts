export type Locale = "en" | "zh-CN" | "ja";
export type LanguagePreference = Locale | "system";

export const LANGUAGE_STORAGE_KEY = "codesesh.language";
const listeners = new Set<() => void>();

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "en" || value === "zh-CN" || value === "ja";
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "zh") return "zh-CN";
    if (base === "ja") return "ja";
    if (base === "en") return "en";
  }
  return "en";
}

function readPreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

function resolvePreference(preference: LanguagePreference): Locale {
  return preference === "system"
    ? resolveLocale(typeof navigator === "undefined" ? [] : navigator.languages)
    : preference;
}

const preference = readPreference();
let snapshot = { preference, locale: resolvePreference(preference) };

export function getLanguageSnapshot() {
  return snapshot;
}

export function getLocale(): Locale {
  return snapshot.locale;
}

function update(preference: LanguagePreference) {
  const locale = resolvePreference(preference);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (snapshot.preference === preference && snapshot.locale === locale) return;
  snapshot = { preference, locale };
  for (const listener of listeners) listener();
}

export function setLanguagePreference(preference: LanguagePreference) {
  if (!isLanguagePreference(preference)) return;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // Language switching remains available when browser storage is blocked.
  }
  update(preference);
}

function onStorage(event: StorageEvent) {
  if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) update(readPreference());
}

function onLanguageChange() {
  update(snapshot.preference);
}

export function subscribeLanguage(listener: () => void) {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    window.addEventListener("languagechange", onLanguageChange);
    update(snapshot.preference);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("languagechange", onLanguageChange);
    }
  };
}

if (typeof document !== "undefined") document.documentElement.lang = snapshot.locale;
