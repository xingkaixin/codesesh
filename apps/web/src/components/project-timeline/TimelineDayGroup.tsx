import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * One calendar day on the project timeline: a group row with the day's counts,
 * then each main session row with its sub-sessions.
 */
import type { SessionReference } from "@codesesh/contract";
import type { AgentCatalog } from "../../lib/agents";
import {
  isRowExpanded,
  type SubSessionMode,
  type TimelinePageDay,
} from "../../lib/session-timeline";
import { TimelineSessionRow } from "./TimelineSessionRow";

export function TimelineDayGroup({
  day,
  mode,
  openIds,
  agentCatalog,
  onToggle,
  onOpen,
}: {
  day: TimelinePageDay;
  mode: SubSessionMode;
  openIds: ReadonlySet<string>;
  agentCatalog: AgentCatalog;
  onToggle: (routeKey: string) => void;
  onOpen: (reference: SessionReference) => void;
}) {
  useLocale();

  return (
    <>
      <tbody>
        <tr>
          <th
            scope="colgroup"
            colSpan={5}
            className="border-b border-[var(--console-border)] bg-[var(--console-bg)] px-[18px] py-[7px] text-left text-xs font-normal text-[var(--console-muted)]"
          >
            {t("{0} · {1} main sessions · {2} sub-sessions", [
              day.label,
              day.mainCount,
              day.subCount,
            ])}
          </th>
        </tr>
      </tbody>
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
    </>
  );
}
