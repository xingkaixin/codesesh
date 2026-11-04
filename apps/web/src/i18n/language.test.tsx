import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesMenu } from "../components/app/SidebarFooter";
import { useLocale } from "../hooks/useLocale";
import {
  getLanguageSnapshot,
  LANGUAGE_STORAGE_KEY,
  resolveLocale,
  setLanguagePreference,
} from "./language";
import { t } from "./translate";
import { messages } from "./messages";

beforeEach(() => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  setLanguagePreference("system");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguagePreference("system");
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

function Preview() {
  useLocale();
  return (
    <>
      <PreferencesMenu theme="light" onChangeTheme={vi.fn()} onShowShortcuts={vi.fn()} />
      <h1>{t("Dashboard")}</h1>
    </>
  );
}

function chooseLanguage(preferencesLabel: string, language: string) {
  fireEvent.click(screen.getByRole("button", { name: preferencesLabel }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: language }));
}

describe("UI language", () => {
  it.each([
    [["zh-CN", "en-US"], "zh-CN"],
    [["zh-Hant-TW"], "zh-CN"],
    [["ja-JP"], "ja"],
    [["fr-FR", "ja-JP", "en"], "ja"],
    [["en-GB", "zh"], "en"],
    [["de-DE"], "en"],
    [[], "en"],
  ] as const)("resolves ordered browser preferences %j", (languages, expected) => {
    expect(resolveLocale(languages)).toBe(expected);
  });

  it("synchronizes a saved choice from another tab and handles invalid stored values", () => {
    render(<Preview />);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "ja");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY })));
    expect(screen.getByRole("heading").textContent).toBe("ダッシュボード");
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "invalid");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY })));
    expect(getLanguageSnapshot().preference).toBe("system");
    expect(screen.getByRole("heading").textContent).toBe("Dashboard");
  });

  it("keeps switching available when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Preview />);
    chooseLanguage("Preferences", "简体中文");
    expect(screen.getByRole("heading").textContent).toBe("概览");
  });
});

describe("message catalog", () => {
  it("keeps both translations populated with valid interpolation slots", () => {
    for (const [key, translations] of Object.entries(messages)) {
      const slots = new Set(key.match(/\{\d+\}/g) ?? []);
      for (const translation of translations) {
        expect(translation.trim(), key).not.toBe("");
        for (const slot of translation.match(/\{\d+\}/g) ?? [])
          expect(slots.has(slot), key).toBe(true);
      }
    }
  });

  it("interpolates user data literally, without translating or recursively substituting it", () => {
    expect(t('Searching for "{0}"', ["Dashboard <script>{1}</script>"], "zh-CN")).toBe(
      "正在搜索“Dashboard <script>{1}</script>”",
    );
    expect(t("Unknown custom text", [], "ja")).toBe("Unknown custom text");
  });
});
