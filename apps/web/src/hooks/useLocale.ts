import { useSyncExternalStore } from "react";
import { getLanguageSnapshot, subscribeLanguage } from "../i18n/language";

export function useLocale() {
  // Subscribe to the full snapshot so async catalog arrival triggers a re-render.
  return useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot).locale;
}
