import { useSyncExternalStore } from "react";
import { getLanguageSnapshot, subscribeLanguage } from "../i18n/language";

export function useLocale() {
  return useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot).locale;
}
