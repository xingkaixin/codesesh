/**
 * One calendar day on the project timeline: a right-aligned day label plus the
 * day's session cards hanging off a single axis dot.
 */
import type { SessionReference } from "@codesesh/core/contract";
import type { AgentCatalog } from "../../lib/agents";
import { isRowExpanded, type SubSessionMode, type TimelineDay } from "../../lib/session-timeline";
import { TimelineSessionRow } from "./timeline-session-row";

export function TimelineDayGroup({
  day,
  mode,
  openIds,
  agentCatalog,
  onToggle,
  onOpen,
}: {
  day: TimelineDay;
  mode: SubSessionMode;
  openIds: ReadonlySet<string>;
  agentCatalog: AgentCatalog;
  onToggle: (routeKey: string) => void;
  onOpen: (reference: SessionReference) => void;
}) {
  return (
    <div className="flex gap-5">
      {/* pt-[14px] optically aligns the day label with the first card's title. */}
      <div className="w-[84px] shrink-0 pt-[14px] text-right">
        <div className="console-display text-[15px] font-semibold text-[var(--console-text)]">
          {day.label}
        </div>
        <div className="console-mono mt-0.5 text-[10px] text-[var(--console-muted)]">
          {day.mainCount} main · {day.subCount} sub
        </div>
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-2.5 border-l border-[var(--console-border)] py-2.5 pr-0 pl-[22px]">
        <span className="absolute top-[18px] -left-[4px] size-[7px] rounded-full bg-[var(--brand)]" />
        {day.rows.map((row) => (
          <TimelineSessionRow
            key={row.routeKey}
            row={row}
            mode={mode}
            expanded={isRowExpanded(row, mode, openIds)}
            agentCatalog={agentCatalog}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}
