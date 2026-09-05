import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { Link } from "react-router-dom";
import type { RouteHeaderModel } from "../../lib/build-route-header-model";
import { CopyResumeButton } from "../CopyResumeButton";
import { PanelLeftOpen } from "../ui/icons";
import { ScanStatusNotice } from "./ScanStatusNotice";

interface ResumeSessionAction {
  resumeCommandPrefix: string | null;
  sessionId: string;
  directory?: string | null;
}

interface SessionLoadNotice {
  loading: boolean;
  error: string | null;
}

export interface AppPageHeaderModel {
  mobileNavigationOpen: boolean;
  sidebarCollapsed: boolean;
  route: RouteHeaderModel;
  shortcutHintVisible: boolean;
  sessionBackHintVisible: boolean;
  resumeSession: ResumeSessionAction | null;
  sessionCopyNotice: string | null;
  liveNotice: string | null;
  scanStatusVisible: boolean;
  sessionLoadNotice: SessionLoadNotice | null;
}

export interface AppPageHeaderActions {
  onOpenMobileNavigation: () => void;
  onExpandSidebar: () => void;
  onDismissShortcutHint: () => void;
  onRetrySessionLoad: () => void;
}

export function AppPageHeader({
  model: {
    mobileNavigationOpen,
    sidebarCollapsed,
    route,
    shortcutHintVisible,
    sessionBackHintVisible,
    resumeSession,
    sessionCopyNotice,
    liveNotice,
    scanStatusVisible,
    sessionLoadNotice,
  },
  actions: { onOpenMobileNavigation, onExpandSidebar, onDismissShortcutHint, onRetrySessionLoad },
}: {
  model: AppPageHeaderModel;
  actions: AppPageHeaderActions;
}) {
  useLocale();

  return (
    <section className="flex shrink-0 items-start gap-3 border-b border-[var(--console-border)] bg-[var(--console-surface)]/70 px-4 py-4 backdrop-blur-sm md:px-8">
      <button
        type="button"
        aria-expanded={mobileNavigationOpen}
        aria-label={t("Open navigation")}
        title={t("Open navigation")}
        onClick={onOpenMobileNavigation}
        className="mt-0.5 inline-flex shrink-0 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none min-[1025px]:hidden"
      >
        <PanelLeftOpen className="size-4" />
      </button>
      {sidebarCollapsed ? (
        <button
          type="button"
          aria-expanded="false"
          aria-label={t("Expand sidebar")}
          title={t("Expand sidebar")}
          onClick={onExpandSidebar}
          className="mt-0.5 hidden shrink-0 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-1 text-[var(--console-muted)] motion-hover hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none min-[1025px]:inline-flex"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <nav
          aria-label={t("Breadcrumb")}
          className="console-mono mb-2 flex flex-wrap items-center gap-1 text-[11px] text-[var(--console-muted)]"
        >
          {route.breadcrumbs.map((item, index) => (
            <span key={`${item.label}-${index}`} className="flex items-center gap-1">
              {item.to ? (
                <Link to={item.to} className="motion-hover hover:text-[var(--console-text)]">
                  {item.label}
                </Link>
              ) : (
                <span className="text-[var(--console-text)]">{item.label}</span>
              )}
              {index < route.breadcrumbs.length - 1 ? <span>/</span> : null}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <span className="console-eyebrow rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5">
            {route.contextLabel}
          </span>
          <h1 className="console-display text-2xl font-semibold text-[var(--console-text)]">
            {route.title}
          </h1>
        </div>
        <div className="console-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--console-muted)]">
          {route.subtitle}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {shortcutHintVisible ? (
            <div className="console-mono inline-flex items-center gap-2 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
              <span>{t("Keyboard navigation available")}</span>
              <span className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-1">
                ?
              </span>
              <button
                type="button"
                onClick={onDismissShortcutHint}
                className="text-[var(--console-muted)] motion-hover hover:text-[var(--console-text)]"
                aria-label={t("Dismiss keyboard shortcuts hint")}
              >
                ×
              </button>
            </div>
          ) : null}
          {sessionBackHintVisible ? (
            <span className="console-mono inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-muted)]">
              {t("Esc back")}
            </span>
          ) : null}
          {resumeSession ? <CopyResumeButton {...resumeSession} /> : null}
        </div>
        <div aria-live="polite">
          {sessionCopyNotice ? (
            <p className="console-mono mt-2 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
              {sessionCopyNotice}
            </p>
          ) : null}
          {liveNotice ? (
            <p className="console-mono mt-2 inline-flex rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[11px] text-[var(--console-text)]">
              {liveNotice}
            </p>
          ) : null}
        </div>
        <ScanStatusNotice visible={scanStatusVisible} />
        {sessionLoadNotice ? (
          <div
            role={sessionLoadNotice.error ? "alert" : "status"}
            className="console-mono mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-[var(--console-warning-border)] bg-[var(--console-warning-bg)] px-2 py-1 text-[11px] text-[var(--console-warning)]"
          >
            <span>
              {sessionLoadNotice.error ?? t("Loading sessions… Results are not yet complete.")}
            </span>
            {sessionLoadNotice.error ? (
              <button
                type="button"
                disabled={sessionLoadNotice.loading}
                onClick={onRetrySessionLoad}
                className="rounded-sm border border-current px-2 py-1 focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:opacity-50"
              >
                {t("Retry session load")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
