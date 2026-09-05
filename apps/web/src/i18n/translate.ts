import { messages } from "./messages";
import { getLocale, type Locale } from "./language";

export function t(
  message: string,
  values: readonly (string | number)[] = [],
  locale: Locale = getLocale(),
): string {
  const translation = Object.hasOwn(messages, message)
    ? messages[message as keyof typeof messages]
    : undefined;
  const template =
    locale === "en" || !translation ? message : translation[locale === "zh-CN" ? 0 : 1];
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    values[Number(index)] == null ? placeholder : String(values[Number(index)]),
  );
}
