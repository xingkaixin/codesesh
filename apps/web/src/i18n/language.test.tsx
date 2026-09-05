import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { LanguageControl } from "../components/app/LanguageControl";
import { TimeWindowControl } from "../components/TimeWindowControl";
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
  const [draft, setDraft] = useState("");
  return (
    <>
      <LanguageControl />
      <h1>{t("Dashboard")}</h1>
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </>
  );
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

  it("switches in place, persists the choice, and follows later system changes", () => {
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    setLanguagePreference("system");
    render(<Preview />);
    expect(screen.getByRole("heading").textContent).toBe("概览");
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "Dashboard 日本語 /my/project" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "语言" }), { target: { value: "ja" } });
    expect(screen.getByRole("heading").textContent).toBe("ダッシュボード");
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
      "Dashboard 日本語 /my/project",
    );
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");

    languages.mockReturnValue(["en-GB"]);
    act(() => window.dispatchEvent(new Event("languagechange")));
    expect(screen.getByRole("heading").textContent).toBe("ダッシュボード");
    fireEvent.change(screen.getByRole("combobox", { name: "言語" }), {
      target: { value: "system" },
    });
    expect(screen.getByRole("heading").textContent).toBe("Dashboard");
    languages.mockReturnValue(["zh-CN"]);
    act(() => window.dispatchEvent(new Event("languagechange")));
    expect(screen.getByRole("heading").textContent).toBe("概览");
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
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
      target: { value: "zh-CN" },
    });
    expect(screen.getByRole("heading").textContent).toBe("概览");
  });

  it("translates time presets without changing their query values", () => {
    setLanguagePreference("ja");
    const onSelectPreset = vi.fn();
    render(
      <TimeWindowControl
        window={{ days: 0 }}
        preset="all"
        onSelectPreset={onSelectPreset}
        onSelectCustom={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "セッションの期間" }), {
      target: { value: "7d" },
    });
    expect(onSelectPreset).toHaveBeenCalledWith("7d");
    expect(screen.getByRole("option", { name: "全期間" })).toBeDefined();
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
