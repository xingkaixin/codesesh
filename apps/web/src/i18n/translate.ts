import { syncMessages } from "./sync-catalog";
import { getLocale, notifyLanguageListeners, type Locale } from "./language";

const loadedCatalogs: Partial<Record<"zh-CN" | "ja", Record<string, string>>> = {};
const inflightLoads: Partial<Record<"zh-CN" | "ja", Promise<void>>> = {};

export function loadLocaleCatalog(locale: Locale): Promise<void> {
  if (locale === "en" || syncMessages !== null || loadedCatalogs[locale]) {
    return Promise.resolve();
  }
  const existing = inflightLoads[locale];
  if (existing) return existing;
  const loader = locale === "zh-CN" ? import("./catalog-zh") : import("./catalog-ja");
  const promise = loader
    .then((mod) => {
      loadedCatalogs[locale] = mod.default;
      notifyLanguageListeners();
    })
    .finally(() => {
      delete inflightLoads[locale];
    });
  inflightLoads[locale] = promise;
  return promise;
}

export function t(
  message: string,
  values: readonly (string | number)[] = [],
  locale: Locale = getLocale(),
  additionalMessages?: Readonly<Record<string, readonly [string, string]>>,
): string {
  let template: string;
  if (locale === "en") {
    template = message;
  } else if (additionalMessages && Object.hasOwn(additionalMessages, message)) {
    template = additionalMessages[message]![locale === "zh-CN" ? 0 : 1];
  } else if (syncMessages !== null && Object.hasOwn(syncMessages, message)) {
    template = syncMessages[message as keyof typeof syncMessages][locale === "zh-CN" ? 0 : 1];
  } else {
    const catalog = loadedCatalogs[locale];
    if (!catalog) {
      void loadLocaleCatalog(locale);
      template = message;
    } else {
      template = Object.hasOwn(catalog, message) ? catalog[message]! : message;
    }
  }
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    values[Number(index)] == null ? placeholder : String(values[Number(index)]),
  );
}
