import type { ReactNode } from "react";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { Link } from "react-router-dom";
import type { RouteHeaderModel } from "../../lib/build-route-header-model";
import { cn } from "../../lib/utils";
import { PanelLeftOpen } from "../ui/icons";

const BAR_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--console-muted)] motion-hover hover:bg-[var(--console-sidebar-accent)] hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none";

/** The 43px bar on top of the main panel: where you are on the left, page actions on the right. */
export function AppPageHeader({
  route,
  mobileNavigationOpen,
  sidebarCollapsed,
  onOpenMobileNavigation,
  onExpandSidebar,
  actions,
}: {
  route: RouteHeaderModel;
  mobileNavigationOpen: boolean;
  sidebarCollapsed: boolean;
  onOpenMobileNavigation: () => void;
  onExpandSidebar: () => void;
  actions?: ReactNode;
}) {
  useLocale();
  const crumbs = route.breadcrumbs;

  return (
    <header className="flex min-h-[43px] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-[var(--console-border)] py-1.5 pr-4 pl-3 md:pl-6">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <button
          type="button"
          aria-expanded={mobileNavigationOpen}
          aria-label={t("Open navigation")}
          title={t("Open navigation")}
          onClick={onOpenMobileNavigation}
          className={cn(BAR_BUTTON_CLASS, "min-[1025px]:hidden")}
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
            className={cn(BAR_BUTTON_CLASS, "hidden min-[1025px]:inline-flex")}
          >
            <PanelLeftOpen className="size-4" />
          </button>
        ) : null}
        {crumbs.length > 0 ? (
          <nav
            aria-label={t("Breadcrumb")}
            className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--console-muted)]"
          >
            {crumbs.map((item, index) => {
              const last = index === crumbs.length - 1;
              return (
                <span
                  key={`${item.label}-${index}`}
                  className={cn(
                    "min-w-0 items-center gap-1.5",
                    last || index === crumbs.length - 2 ? "flex" : "hidden sm:flex",
                    last ? "min-w-0 flex-1" : "shrink-0",
                  )}
                >
                  {item.to && !last ? (
                    <Link
                      to={item.to}
                      className={cn(
                        "max-w-48 truncate rounded-sm motion-hover hover:text-[var(--console-text)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
                        item.mono && "console-mono",
                      )}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span
                      aria-current="page"
                      className={cn(
                        "truncate text-[var(--console-text)]",
                        item.mono && "console-mono",
                      )}
                    >
                      {item.label}
                    </span>
                  )}
                  {!last ? (
                    <span aria-hidden="true" className="text-[var(--console-border-strong)]">
                      /
                    </span>
                  ) : null}
                </span>
              );
            })}
          </nav>
        ) : (
          <h1 className="flex min-w-0 items-center gap-2 text-sm font-normal text-[var(--console-text)]">
            <span className="truncate">{route.title}</span>
            {route.count != null ? (
              <span className="console-mono inline-flex h-5 items-center rounded-[6px] bg-[var(--console-surface-muted)] px-[7px] text-[10px] font-medium text-[var(--console-muted)]">
                {route.count}
              </span>
            ) : null}
          </h1>
        )}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** The large title block that opens a page body. */
export function AppPageHero({
  hero,
  children,
}: {
  hero: NonNullable<RouteHeaderModel["hero"]>;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="console-eyebrow">{hero.eyebrow}</span>
      <h1 className="console-display min-w-0 text-2xl leading-tight font-light break-words text-[var(--console-text)] sm:text-[28px]">
        {hero.title}
      </h1>
      {hero.subtitle ? (
        <p className="console-mono flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--console-muted)]">
          {hero.subtitle}
        </p>
      ) : null}
      {hero.tags ? <div className="mt-1">{hero.tags}</div> : null}
      {children}
    </div>
  );
}
