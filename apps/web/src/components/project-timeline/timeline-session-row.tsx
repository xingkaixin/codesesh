/**
 * One main session on the project timeline. Its numbers are inclusive of every
 * sub-session, which the 含子 suffixes make visible; the mode only decides
 * whether those sub-sessions can be revealed.
 */
import { useId } from "react";
import type { SessionReference } from "@codesesh/core/contract";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { formatClockTime, formatCompact, formatInt, formatUsd } from "../../lib/format";
import type { SubSessionMode, TimelineRow } from "../../lib/session-timeline";
import { AgentIcon } from "../AgentIcon";
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
  const panelId = useId();
  const agent = findAgent(agentCatalog, row.agentKey);
  const agentName = agent?.displayName ?? row.agentKey;
  const hasChildren = row.childCount > 0;

  return (
    <article
      className={`overflow-hidden rounded-lg border bg-[var(--console-surface)] shadow-[var(--shadow-raised)] ${
        expanded ? "border-[var(--brand-line)]" : "border-[var(--console-border)]"
      }`}
    >
      <div className="flex items-center gap-[13px] p-[13px_16px]">
        <span className="console-mono w-[38px] shrink-0 text-[11px] text-[var(--console-muted)]">
          {formatClockTime(row.time)}
        </span>
        {row.isOrphan ? (
          <span className="console-mono shrink-0 rounded-sm border border-[var(--console-border-strong)] px-1.5 text-[9.5px] text-[var(--console-muted)]">
            Unmounted
          </span>
        ) : null}
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
          {agent?.icon ? (
            <AgentIcon
              icon={agent.icon}
              iconColored={agent.iconColored}
              alt={agentName}
              className="size-[13px] object-contain"
            />
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => onOpen(row.reference)}
          className="min-w-0 flex-1 text-left focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
        >
          <span className="block truncate text-[13.5px] font-medium text-[var(--console-text)]">
            {row.title}
          </span>
          <span className="console-mono mt-[3px] block truncate text-[10.5px] text-[var(--console-muted)]">
            {agentName} · {formatInt(row.messageCount)} msgs · {formatCompact(row.tokens)} tok
            {hasChildren ? ` · ${row.childCount} sub-sessions` : ""}
          </span>
        </button>
        {hasChildren && mode !== "hidden" ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => onToggle(row.routeKey)}
            className="console-mono motion-hover inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--brand-line)] bg-[var(--brand-soft)] px-2.5 py-[3px] text-[10.5px] text-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none"
          >
            <span className="text-[11px]">⑂</span>
            {row.childCount} sub
            <span className="opacity-70">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : null}
        <span className="console-mono w-[76px] shrink-0 text-right text-[11px] text-[var(--console-muted)]">
          {formatUsd(row.cost)}
          {hasChildren ? " incl. sub" : ""}
        </span>
      </div>
      {expanded ? <TimelineChildPanel id={panelId} rows={row.children} onOpen={onOpen} /> : null}
    </article>
  );
}
