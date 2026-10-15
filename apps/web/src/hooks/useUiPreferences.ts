import { useCallback, useRef, useState } from "react";

export type Theme = "light" | "dark" | "system";

const THEMES: readonly Theme[] = ["light", "dark", "system"];

export interface UiPreferences {
  sidebarCollapsed: boolean;
  theme: Theme;
}

interface StoredUiPreferences {
  version: 1;
  state: UiPreferences;
}

type UiPreferencesStorage = Pick<Storage, "getItem" | "setItem">;

export const UI_PREFERENCES_STORAGE_KEY = "codesesh.ui-preferences";

const DEFAULT_UI_PREFERENCES: UiPreferences = {
  sidebarCollapsed: false,
  theme: "system",
};

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEMES.includes(value as Theme);
}

function getBrowserStorage(): UiPreferencesStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseUiPreferences(raw: string | null): UiPreferences | null {
  if (!raw) return null;
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!isRecord(envelope) || envelope.version !== 1 || !isRecord(envelope.state)) return null;
    const { sidebarCollapsed, theme } = envelope.state;
    if (typeof sidebarCollapsed !== "boolean") return null;
    // theme predates CS-89: absent in preferences persisted before this field
    // existed, so treat it as "system" rather than invalidating the envelope.
    if (theme !== undefined && !isTheme(theme)) return null;
    return { sidebarCollapsed, theme: isTheme(theme) ? theme : "system" };
  } catch {
    return null;
  }
}

function loadUiPreferences(
  storage: UiPreferencesStorage | null = getBrowserStorage(),
): UiPreferences {
  if (!storage) return DEFAULT_UI_PREFERENCES;
  try {
    const raw = storage.getItem(UI_PREFERENCES_STORAGE_KEY);
    return parseUiPreferences(raw) ?? DEFAULT_UI_PREFERENCES;
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

function persistUiPreferences(
  preferences: UiPreferences,
  storage: UiPreferencesStorage | null = getBrowserStorage(),
) {
  if (!storage) return;
  const envelope: StoredUiPreferences = {
    version: 1,
    state: {
      sidebarCollapsed: preferences.sidebarCollapsed,
      theme: preferences.theme,
    },
  };
  try {
    storage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    return;
  }
}

export function useUiPreferences() {
  const [preferences, setPreferences] = useState(loadUiPreferences);
  const preferencesRef = useRef(preferences);

  const updatePreferences = useCallback((next: UiPreferences) => {
    preferencesRef.current = next;
    setPreferences(next);
    persistUiPreferences(next);
  }, []);

  const setSidebarCollapsed = useCallback(
    (sidebarCollapsed: boolean) => {
      updatePreferences({ ...preferencesRef.current, sidebarCollapsed });
    },
    [updatePreferences],
  );

  const setTheme = useCallback(
    (theme: Theme) => {
      updatePreferences({ ...preferencesRef.current, theme });
    },
    [updatePreferences],
  );

  return {
    ...preferences,
    setSidebarCollapsed,
    setTheme,
  };
}
