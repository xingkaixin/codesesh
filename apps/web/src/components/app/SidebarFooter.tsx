import { Menu } from "@base-ui/react/menu";
import { lazy, Suspense, useContext, useRef, useState, useSyncExternalStore } from "react";
import { useLocale } from "../../hooks/useLocale";
import { isNodeOnline, useNodeClock, useNodes } from "../../hooks/useNodes";
import { useScanStatus } from "../../hooks/useScanStatus";
import { ResolvedThemeContext } from "../../hooks/useTheme";
import type { Theme } from "../../hooks/useUiPreferences";
import {
  getLanguageSnapshot,
  setLanguagePreference,
  subscribeLanguage,
  type LanguagePreference,
} from "../../i18n/language";
import { t } from "../../i18n/translate";
import { formatInt } from "../../lib/format";
import { cn } from "../../lib/utils";
import { nodeNeedsAttention } from "../nodes/node-status";
import { ChevronsUpDown, Globe } from "../ui/icons";

declare const __APP_VERSION__: string;

const NodePanel = lazy(() =>
  import("../nodes/NodePanel").then((module) => ({ default: module.NodePanel })),
);

const LANGUAGE_OPTIONS: { value: LanguagePreference; label: string }[] = [
  { value: "system", label: "Follow system" },
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-[var(--console-text)] outline-none data-[highlighted]:bg-[var(--brand-soft)]";

export function NodeSummary({ onManage }: { onManage: () => void }) {
  useLocale();
  const nodes = useNodes();
  const now = useNodeClock();
  const active = nodes.data?.nodes.filter((node) => !node.revoked) ?? [];
  const online = active.filter((node) => isNodeOnline(node, now)).length;
  const attention = active.filter(nodeNeedsAttention).length;
  const title = nodes.isError
    ? t("Node status unavailable")
    : t("Source nodes {0}/{1} online", [online, active.length]);
  return (
    <>
      <div className="flex items-center gap-2">
        <LiveDot />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        <button
          type="button"
          onClick={onManage}
          aria-haspopup="dialog"
          className="motion-hover shrink-0 rounded-full bg-[var(--ember-glass)] px-2.5 py-0.5 text-xs font-medium hover:bg-[var(--ember-glass-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ember-fg)] focus-visible:outline-none"
        >
          {t("Manage")}
        </button>
      </div>
      {attention > 0 ? (
        <p className="text-[11px] leading-snug text-[var(--ember-muted)]">
          {t("{0} need attention", [attention])}
        </p>
      ) : null}
    </>
  );
}

function LiveDot() {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full bg-[var(--ember-live)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--ember-live)_22%,transparent)]"
    />
  );
}

function LocalSummary({ sessionCount }: { sessionCount: number }) {
  useLocale();
  const scanStatus = useScanStatus();
  return (
    <>
      <div className="flex items-center gap-2">
        <LiveDot />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {t("Local source")}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-[var(--ember-muted)]">
        {scanStatus?.active
          ? t("Scanning · {0} sessions so far", [formatInt(sessionCount)])
          : t("{0} sessions in range", [formatInt(sessionCount)])}
      </p>
    </>
  );
}

export function PreferencesMenu({
  theme,
  onChangeTheme,
  onShowShortcuts,
}: {
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  onShowShortcuts: () => void;
}) {
  useLocale();
  const { preference, locale } = useSyncExternalStore(
    subscribeLanguage,
    getLanguageSnapshot,
    getLanguageSnapshot,
  );
  const resolvedTheme = useContext(ResolvedThemeContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const languageLabel = LANGUAGE_OPTIONS.find((option) => option.value === locale)?.label;

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        ref={triggerRef}
        aria-label={t("Preferences")}
        className="motion-hover flex w-full items-center gap-2 rounded-lg bg-[var(--console-surface)] p-2 text-left text-[var(--console-text)] shadow-[var(--shadow-raised)] hover:bg-[var(--console-bg)] focus-visible:ring-2 focus-visible:ring-[var(--brand-line)] focus-visible:outline-none data-[popup-open]:ring-2 data-[popup-open]:ring-[var(--brand-line)]"
      >
        <Globe aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs">
          {languageLabel} · {t(resolvedTheme === "dark" ? "Dark" : "Light")}
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-4 shrink-0 text-[var(--console-muted)]"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8} className="z-[60]">
          <Menu.Popup
            finalFocus={triggerRef}
            className="motion-menu w-60 rounded-lg border border-[var(--console-border)] bg-[var(--console-bg)] p-1.5 shadow-[var(--shadow-overlay)] focus-visible:outline-none"
          >
            <Menu.RadioGroup
              value={preference}
              onValueChange={(value: LanguagePreference) => setLanguagePreference(value)}
            >
              <Menu.GroupLabel className="px-2 pt-1.5 pb-1 text-[11px] text-[var(--console-muted)]">
                {t("Language")}
              </Menu.GroupLabel>
              {LANGUAGE_OPTIONS.map((option) => (
                <Menu.RadioItem
                  key={option.value}
                  value={option.value}
                  closeOnClick
                  className={MENU_ITEM_CLASS}
                >
                  <RadioMark checked={preference === option.value} />
                  {option.value === "system" ? t(option.label) : option.label}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <div role="separator" className="mx-0.5 my-1 h-px bg-[var(--console-border)]" />
            <Menu.RadioGroup value={theme} onValueChange={(value: Theme) => onChangeTheme(value)}>
              <Menu.GroupLabel className="px-2 pt-1.5 pb-1 text-[11px] text-[var(--console-muted)]">
                {t("Theme")}
              </Menu.GroupLabel>
              <div className="mx-1 mt-0.5 mb-1 flex gap-0.5 rounded-[10px] bg-[var(--console-sidebar-bg)] p-[3px]">
                {THEME_OPTIONS.map((option) => (
                  <Menu.RadioItem
                    key={option.value}
                    value={option.value}
                    className={cn(
                      "flex h-[26px] flex-1 items-center justify-center rounded-md text-xs font-medium outline-none data-[highlighted]:text-[var(--console-text)]",
                      theme === option.value
                        ? "bg-[var(--console-surface)] text-[var(--console-text)] shadow-[var(--shadow-raised)]"
                        : "text-[var(--console-muted)]",
                    )}
                  >
                    {t(option.label)}
                  </Menu.RadioItem>
                ))}
              </div>
            </Menu.RadioGroup>
            <div role="separator" className="mx-0.5 my-1 h-px bg-[var(--console-border)]" />
            <Menu.Item onClick={onShowShortcuts} className={MENU_ITEM_CLASS}>
              <kbd className="inline-flex h-[18px] items-center rounded-[4px] border border-b-2 border-[var(--console-border)] bg-[var(--console-surface)] px-[5px] text-[10px] font-semibold text-[var(--console-muted)]">
                ?
              </kbd>
              {t("Shortcuts")}
            </Menu.Item>
            <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1 text-[11px] text-[var(--console-muted)]">
              <span>CodeSesh</span>
              <span className="console-mono rounded-[6px] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px]">
                v{__APP_VERSION__}
              </span>
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border",
        checked
          ? "border-[var(--brand)] bg-[var(--brand)]"
          : "border-[var(--console-border-strong)] bg-[var(--console-surface)]",
      )}
    >
      {checked ? <span className="size-1.5 rounded-full bg-[var(--brand-fg)]" /> : null}
    </span>
  );
}

export function SidebarFooter({
  hubEnabled,
  sessionCount,
  theme,
  onChangeTheme,
  onShowShortcuts,
}: {
  hubEnabled: boolean;
  sessionCount: number;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  onShowShortcuts: () => void;
}) {
  const [nodesOpen, setNodesOpen] = useState(false);
  return (
    <div className="mt-2 mr-2 shrink-0">
      <div className="relative overflow-hidden rounded-2xl bg-[linear-gradient(90deg,var(--ember-from),var(--ember-to))] text-[var(--ember-fg)] shadow-[var(--shadow-overlay)]">
        <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
          {hubEnabled ? (
            <NodeSummary onManage={() => setNodesOpen(true)} />
          ) : (
            <LocalSummary sessionCount={sessionCount} />
          )}
          <PreferencesMenu
            theme={theme}
            onChangeTheme={onChangeTheme}
            onShowShortcuts={onShowShortcuts}
          />
        </div>
      </div>
      {nodesOpen ? (
        <Suspense fallback={null}>
          <NodePanel onClose={() => setNodesOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
