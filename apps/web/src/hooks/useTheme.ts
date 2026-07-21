import { createContext, useEffect, useState } from "react";
import type { Theme } from "./useUiPreferences";

/** Effective light/dark theme, for components whose colors can't be expressed in CSS (e.g. inline highlighter styles). */
export const ResolvedThemeContext = createContext<"light" | "dark">("light");

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/**
 * Resolves the effective light/dark theme for `theme` (following the OS
 * preference when "system"), keeps it synced to `document.documentElement`'s
 * `.dark` class, and returns it for callers that need it directly.
 */
export function useTheme(theme: Theme): "light" | "dark" {
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const effectiveTheme = theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
  }, [effectiveTheme]);

  return effectiveTheme;
}
