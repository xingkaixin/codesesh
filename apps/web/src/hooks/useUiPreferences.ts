import { useCallback, useRef, useState } from "react";

export interface UiPreferences {
  shortcutHintDismissed: boolean;
  sidebarCollapsed: boolean;
}

interface StoredUiPreferences {
  version: 1;
  state: UiPreferences;
}

type UiPreferencesStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export const UI_PREFERENCES_STORAGE_KEY = "codesesh.ui-preferences";
export const LEGACY_SHORTCUT_HINT_STORAGE_KEY = "codesesh.shortcuts-hint-dismissed";

const DEFAULT_UI_PREFERENCES: UiPreferences = {
  shortcutHintDismissed: false,
  sidebarCollapsed: false,
};

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
    const { shortcutHintDismissed, sidebarCollapsed } = envelope.state;
    if (typeof shortcutHintDismissed !== "boolean" || typeof sidebarCollapsed !== "boolean") {
      return null;
    }
    return { shortcutHintDismissed, sidebarCollapsed };
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
    if (raw !== null) return parseUiPreferences(raw) ?? DEFAULT_UI_PREFERENCES;
    return {
      ...DEFAULT_UI_PREFERENCES,
      shortcutHintDismissed: storage.getItem(LEGACY_SHORTCUT_HINT_STORAGE_KEY) === "1",
    };
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
      shortcutHintDismissed: preferences.shortcutHintDismissed,
      sidebarCollapsed: preferences.sidebarCollapsed,
    },
  };
  try {
    storage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(envelope));
    storage.removeItem(LEGACY_SHORTCUT_HINT_STORAGE_KEY);
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

  const dismissShortcutHint = useCallback(() => {
    updatePreferences({ ...preferencesRef.current, shortcutHintDismissed: true });
  }, [updatePreferences]);

  const setSidebarCollapsed = useCallback(
    (sidebarCollapsed: boolean) => {
      updatePreferences({ ...preferencesRef.current, sidebarCollapsed });
    },
    [updatePreferences],
  );

  return {
    ...preferences,
    dismissShortcutHint,
    setSidebarCollapsed,
  };
}
