import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * Screen 2a — the project timeline. Sessions are grouped by calendar day and
 * every sub-session stays under its parent's row, so the day groups only ever
 * carry top-level work.
 */
import { useCallback, useMemo, useState } from "react";
import type { SessionHead, SessionReference } from "@codesesh/contract";
import type { AgentCatalog } from "../../lib/agents";
import {
  buildProjectTimeline,
  getProjectTimelinePage,
  TIMELINE_MAIN_PAGE_SIZE,
  type SubSessionMode,
} from "../../lib/session-timeline";
import { ChevronLeft, ChevronRight } from "../ui/icons";
import { Panel } from "../ui/panel";
import { SubSessionModeSwitch } from "./SubSessionModeSwitch";
import { TimelineDayGroup } from "./TimelineDayGroup";

const COLUMNS = [
  { label: "Time", className: "w-14 pl-[18px]" },
  { label: "Session", className: "" },
  { label: "Tags", className: "" },
  { label: "Sub-sessions", className: "w-24" },
  { label: "Cost", className: "w-28 pr-[18px] text-right" },
] as const;

const PAGER_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 text-xs text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

export function ProjectTimeline({
  sessions,
  projectName,
  agentCatalog,
  onOpenSession,
}: {
  sessions: SessionHead[];
  projectName: string;
  agentCatalog: AgentCatalog;
  onOpenSession: (reference: SessionReference) => void;
}) {
  const locale = useLocale();

  const [mode, setMode] = useState<SubSessionMode>("collapsed");
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pageOffset, setPageOffset] = useState(0);
  const timeline = useMemo(
    () => buildProjectTimeline(sessions),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, sessions],
  );
  const page = useMemo(() => getProjectTimelinePage(timeline, pageOffset), [pageOffset, timeline]);
  const paged = timeline.mainCount > TIMELINE_MAIN_PAGE_SIZE;

  // Mode changes deliberately leave openIds alone: collapsed -> expanded -> collapsed
  // must restore the rows the user had opened.
  const toggleRow = useCallback((routeKey: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (!next.delete(routeKey)) next.add(routeKey);
      return next;
    });
  }, []);

  return (
    <Panel aria-label={t("{0} timeline", [projectName])} className="min-w-0 overflow-hidden">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--console-border)] px-[18px] py-2.5">
        <h3 className="text-sm font-semibold text-[var(--console-text)]">{t("Timeline")}</h3>
        <SubSessionModeSwitch mode={mode} onChange={setMode} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-separate border-spacing-0 text-[13px]">
          <caption className="sr-only">{t("{0} timeline", [projectName])}</caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  className={`h-9 border-b border-[var(--console-border)] bg-[var(--console-bg)] px-3 text-left text-xs font-medium whitespace-nowrap text-[var(--console-muted)] ${column.className}`}
                >
                  {t(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          {page.days.map((day) => (
            <TimelineDayGroup
              key={day.dayKey}
              day={day}
              mode={mode}
              openIds={openIds}
              agentCatalog={agentCatalog}
              onToggle={toggleRow}
              onOpen={onOpenSession}
            />
          ))}
        </table>
      </div>

      {paged || timeline.orphanCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--console-border)] px-[18px] py-3 text-xs text-[var(--console-muted)]">
          <div className="flex min-w-0 flex-wrap gap-x-2">
            {paged ? <span>{t("Page {0} · {1} shown", [page.pageNumber, page.shown])}</span> : null}
            {timeline.orphanCount > 0 ? (
              <span>
                {timeline.orphanCount} {t("unmounted sub-sessions · parent file is gone")}
              </span>
            ) : null}
          </div>
          {paged ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={t("Previous timeline page")}
                disabled={!page.hasPrevious}
                onClick={() => setPageOffset(page.offset - TIMELINE_MAIN_PAGE_SIZE)}
                className={PAGER_BUTTON_CLASS}
              >
                <ChevronLeft aria-hidden="true" className="size-3.5" />
                {t("Previous")}
              </button>
              <button
                type="button"
                aria-label={t("Next timeline page")}
                disabled={!page.hasNext}
                onClick={() => setPageOffset(page.offset + TIMELINE_MAIN_PAGE_SIZE)}
                className={PAGER_BUTTON_CLASS}
              >
                {t("Next")}
                <ChevronRight aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
