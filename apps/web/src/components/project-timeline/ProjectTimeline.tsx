/**
 * Screen 2a — the project timeline. Sessions are grouped by calendar day and
 * every sub-session stays inside its parent's card, so the day axis only ever
 * carries top-level work.
 */
import { useCallback, useMemo, useState } from "react";
import type { SessionHead, SessionReference } from "@codesesh/core/contract";
import type { AgentCatalog } from "../../lib/agents";
import { formatCompact } from "../../lib/format";
import {
  buildProjectTimeline,
  getProjectTimelinePage,
  TIMELINE_MAIN_PAGE_SIZE,
  type SubSessionMode,
} from "../../lib/session-timeline";
import { SubSessionModeSwitch } from "./sub-session-mode-switch";
import { TimelineDayGroup } from "./timeline-day-group";

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
  const [mode, setMode] = useState<SubSessionMode>("collapsed");
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pageOffset, setPageOffset] = useState(0);
  const timeline = useMemo(() => buildProjectTimeline(sessions), [sessions]);
  const page = useMemo(() => getProjectTimelinePage(timeline, pageOffset), [pageOffset, timeline]);

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
    <section aria-label={`${projectName} timeline`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {`${timeline.mainCount} sessions · ${timeline.subCount} sub-sessions · ${formatCompact(timeline.totalTokens)} tokens`}
        </span>
        <div className="ml-auto">
          <SubSessionModeSwitch mode={mode} onChange={setMode} />
        </div>
      </div>

      {timeline.mainCount > TIMELINE_MAIN_PAGE_SIZE ? (
        <div className="console-mono flex items-center justify-between gap-3 text-[11px] text-[var(--console-muted)]">
          <span>
            Page {page.pageNumber} · {page.shown} shown
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous timeline page"
              disabled={!page.hasPrevious}
              onClick={() => setPageOffset(page.offset - TIMELINE_MAIN_PAGE_SIZE)}
              className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-1.5 text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              aria-label="Next timeline page"
              disabled={!page.hasNext}
              onClick={() => setPageOffset(page.offset + TIMELINE_MAIN_PAGE_SIZE)}
              className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2.5 py-1.5 text-[var(--console-text)] motion-hover hover:bg-[var(--console-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
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
      </div>

      {timeline.orphanCount > 0 ? (
        <p className="console-mono text-[10.5px] text-[var(--console-muted)]">
          {timeline.orphanCount} unmounted sub-sessions · parent file is gone
        </p>
      ) : null}
    </section>
  );
}
