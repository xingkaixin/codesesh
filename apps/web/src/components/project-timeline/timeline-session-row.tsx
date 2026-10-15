import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
/**
 * One main session on the project timeline. Its numbers are inclusive of every
 * sub-session, which the "incl. sub-sessions" note makes visible; the mode only
 * decides whether those sub-sessions can be revealed.
 */
import { useId } from "react";
import type { SessionReference } from "@codesesh/contract";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { formatClockTime, formatCompact, formatInt, formatUsd } from "../../lib/format";
import type { SubSessionMode, TimelineRow } from "../../lib/session-timeline";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIcon";
import { SmartTagChips } from "../SmartTagChips";
import { ChevronDown, ChevronRight, GitBranch } from "../ui/icons";
import { TIMELINE_CELL_CLASS, TIMELINE_TIME_CLASS } from "./timeline-cells";
import { TimelineChildPanel } from "./timeline-child-panel";

export function TimelineSessionRow({
  row,
  mode,
  expanded,
  agentCatalog,
  onToggle,
  onOpen,
}: {
  row: TimelineRow;
  mode: SubSessionMode;
  expanded: boolean;
  agentCatalog: AgentCatalog;
  onToggle: (routeKey: string) => void;
  onOpen: (reference: SessionReference) => void;
}) {
  useLocale();

  const panelId = useId();
  const agent = findAgent(agentCatalog, row.agentKey);
  const agentName = agent?.displayName ?? row.agentKey;
  const hasChildren = row.childCount > 0;

  return (
    <>
      <tbody>
        <tr className="motion-hover hover:bg-[var(--console-surface-muted)]">
          <td className={cn(TIMELINE_CELL_CLASS, TIMELINE_TIME_CLASS)}>
            {formatClockTime(row.time)}
          </td>
          <td className={cn(TIMELINE_CELL_CLASS, "max-w-0 min-w-[240px]")}>
            <button
              type="button"
              onClick={() => onOpen(row.reference)}
              className="block w-full min-w-0 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
            >
              <span className="flex min-w-0 items-center gap-1.5 leading-[1.35] font-medium">
                {row.isOrphan ? (
                  <span className="console-mono inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-[var(--console-border-strong)] px-1.5 text-[10px] font-normal text-[var(--console-muted)]">
                    {t("Unmounted")}
                  </span>
                ) : null}
                {agent?.icon ? (
                  <AgentIcon
                    icon={agent.icon}
                    iconColored={agent.iconColored}
                    alt=""
                    className="size-3.5 shrink-0 object-contain"
                  />
                ) : null}
                <span className="truncate">{row.title}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] leading-[1.4] text-[var(--console-muted)]">
                {agentName} · {formatInt(row.messageCount)} {t("msgs ·")}{" "}
                {formatCompact(row.tokens)} {t("tok")}
                {hasChildren ? t(" · {0} sub-sessions", [row.childCount]) : ""}
              </span>
            </button>
          </td>
          <td className={TIMELINE_CELL_CLASS}>
            <SmartTagChips tags={row.tags} limit={3} />
          </td>
          <td className={TIMELINE_CELL_CLASS}>
            {hasChildren && mode !== "hidden" ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={expanded ? panelId : undefined}
                aria-label={t("{0} sub-sessions", [row.childCount])}
                onClick={() => onToggle(row.routeKey)}
                className={cn(
                  "console-mono motion-hover inline-flex h-6 items-center gap-1.5 rounded-full border bg-[var(--console-surface)] px-2.5 text-[11px] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
                  expanded
                    ? "border-[var(--brand-line)] text-[var(--brand)]"
                    : "border-[var(--console-border)] text-[var(--console-muted)] hover:border-[var(--console-border-strong)] hover:text-[var(--console-text)]",
                )}
              >
                <GitBranch aria-hidden="true" className="size-3" />
                {row.childCount}
                {expanded ? (
                  <ChevronDown aria-hidden="true" className="size-3" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3" />
                )}
              </button>
            ) : null}
          </td>
          <td
            className={cn(
              TIMELINE_CELL_CLASS,
              "console-mono pr-[18px] text-right text-xs whitespace-nowrap",
            )}
          >
            {formatUsd(row.cost)}
            {hasChildren ? (
              <span className="block font-sans text-[10px] text-[var(--console-muted)]">
                {t("incl. sub-sessions")}
              </span>
            ) : null}
          </td>
        </tr>
      </tbody>
      {expanded ? <TimelineChildPanel id={panelId} row={row} onOpen={onOpen} /> : null}
    </>
  );
}
