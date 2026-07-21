import { Monitor, Moon, Sun } from "lucide-react";
import type { Theme } from "../../hooks/useUiPreferences";

const THEME_CYCLE: Record<Theme, Theme> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const THEME_ICON: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const THEME_LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (next: Theme) => void;
}) {
  const Icon = THEME_ICON[theme];
  const next = THEME_CYCLE[theme];

  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}.`}
      title={`Theme: ${THEME_LABEL[theme]} (click for ${THEME_LABEL[next]})`}
      className="console-mono motion-hover motion-press rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1.5 text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--console-accent)] focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}
