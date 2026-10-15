import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * The sub-sessions of one timeline row, rendered as indented rows under the
 * parent so a child never gets its own place in the day group.
 */
import type { SessionReference } from "@codesesh/contract";
import { useMemo, useState } from "react";
import { formatClockTime, formatInt, formatUsd } from "../../lib/format";
import {
  getTimelineChildPage,
  TIMELINE_CHILD_PAGE_SIZE,
  type TimelineRow,
} from "../../lib/session-timeline";
import { cn } from "../../lib/utils";
import { SmartTagChips } from "../SmartTagChips";
import { TIMELINE_CELL_CLASS, TIMELINE_TIME_CLASS } from "./timeline-cells";

const CHILD_CELL_CLASS = cn(TIMELINE_CELL_CLASS, "bg-[var(--console-bg)]");
const PAGER_BUTTON_CLASS =
  "rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-[11px] text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

export function TimelineChildPanel({
  id,
  row,
  onOpen,
}: {
  id: string;
  row: TimelineRow;
  onOpen: (reference: SessionReference) => void;
}) {
  useLocale();

  const [pageOffset, setPageOffset] = useState(0);
  const page = useMemo(() => getTimelineChildPage(row, pageOffset), [pageOffset, row]);

  return (
    <tbody id={id}>
      {page.rows.map((child) => (
        <tr key={child.routeKey}>
          <td className={cn(CHILD_CELL_CLASS, TIMELINE_TIME_CLASS)}>
            {formatClockTime(child.time)}
          </td>
          <td className={cn(CHILD_CELL_CLASS, "max-w-0 pl-[30px]")}>
            <button
              type="button"
              onClick={() => onOpen(child.reference)}
              className="block w-full min-w-0 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
            >
              <span className="flex min-w-0 items-center gap-1.5 leading-[1.35] font-medium">
                {child.kind == null ? null : (
                  <span className="console-mono inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-[var(--console-border)] px-1.5 text-[10px] font-normal text-[var(--console-muted)]">
                    {child.kind}
                  </span>
                )}
                <span className="truncate">{child.title}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] leading-[1.4] text-[var(--console-muted)]">
                {t("From this session · {0} msgs", [formatInt(child.messageCount)])}
              </span>
            </button>
          </td>
          <td className={CHILD_CELL_CLASS}>
            <SmartTagChips tags={child.tags} limit={3} />
          </td>
          <td className={CHILD_CELL_CLASS} />
          <td
            className={cn(
              CHILD_CELL_CLASS,
              "console-mono pr-[18px] text-right text-xs whitespace-nowrap",
            )}
          >
            {formatUsd(child.cost)}
          </td>
        </tr>
      ))}
      {page.hasPrevious || page.hasNext ? (
        <tr>
          <td colSpan={5} className={cn(CHILD_CELL_CLASS, "px-[18px] py-2")}>
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-[var(--console-muted)]">
                {t("Page {0} · {1} shown", [page.pageNumber, page.rows.length])}
              </span>
              <button
                type="button"
                aria-label={t("Previous sub-session page")}
                disabled={!page.hasPrevious}
                onClick={() => setPageOffset(page.offset - TIMELINE_CHILD_PAGE_SIZE)}
                className={PAGER_BUTTON_CLASS}
              >
                {t("Previous")}
              </button>
              <button
                type="button"
                aria-label={t("Next sub-session page")}
                disabled={!page.hasNext}
                onClick={() => setPageOffset(page.offset + TIMELINE_CHILD_PAGE_SIZE)}
                className={PAGER_BUTTON_CLASS}
              >
                {t("Next")}
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}
