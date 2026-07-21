import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHead } from "../../lib/api";
import { findAgent, type AgentCatalog } from "../../lib/agents";
import { getSessionAgentKey } from "../../lib/session-indexes";
import { formatRelativeTime } from "../../lib/format";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { SessionActionsMenu } from "../SessionActionsMenu";

// Rows render a single-line, truncated title/timestamp with a fixed-size icon, so
// (unlike chat messages) every row has the same height and doesn't need per-row
// measurement — a constant span plus overscan absorbs any small estimation error.
export const VIRTUALIZED_SESSION_THRESHOLD = 80;
const SESSION_ROW_GAP_PX = 4;
// SessionRow height, measured from rendered output: py-1.5 (12) + border (2)
// + title line (text-xs line-height, 16) + mt-0.5 (2) + timestamp line
// (text-[10px] * line-height 1.5, 15) = 47.
const SESSION_ROW_SPAN_PX = 47;
const SESSION_LIST_OVERSCAN = 8;
const SESSION_LIST_HEIGHT_CLASS = "h-[min(560px,calc(100vh-410px))] min-h-56";

interface SidebarFlatSessionListProps {
  sessions: SessionHead[];
  agentCatalog: AgentCatalog;
  activeSessionId: string | null;
  selectedSessionId: string | null;
  bookmarkedSessionIds: Set<string>;
  onSelectSession: (session: SessionHead) => void;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
}

function SessionRow({
  session,
  agentCatalog,
  active,
  selected,
  onSelectSession,
  onToggleBookmark,
  onRenameSession,
  bookmarkedSessionIds,
}: {
  session: SessionHead;
  agentCatalog: AgentCatalog;
  active: boolean;
  selected: boolean;
  onSelectSession: (session: SessionHead) => void;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
  bookmarkedSessionIds: Set<string>;
}) {
  const agentKey = getSessionAgentKey(session);
  const agent = findAgent(agentCatalog, agentKey);
  return (
    <div
      className={`flex items-start gap-1 rounded-sm border px-2 py-1.5 transition-colors ${
        active || selected
          ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
          : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelectSession(session)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {agent?.icon ? (
            <img
              src={agent.icon}
              alt={agent.displayName}
              className="size-3.5 shrink-0 object-contain"
            />
          ) : null}
          <span className="console-mono line-clamp-1 text-xs text-[var(--console-text)]">
            {getSessionDisplayTitle(session)}
          </span>
        </span>
        <span className="console-mono mt-0.5 block truncate text-[10px] text-[var(--console-muted)]">
          {formatRelativeTime(session.time_updated ?? session.time_created)}
        </span>
      </button>
      <SessionActionsMenu
        bookmarked={bookmarkedSessionIds.has(session.id)}
        onRename={() => onRenameSession(session)}
        onToggleBookmark={() => onToggleBookmark(session)}
      />
    </div>
  );
}

export function SidebarFlatSessionList(props: SidebarFlatSessionListProps) {
  if (props.sessions.length > VIRTUALIZED_SESSION_THRESHOLD) {
    return <VirtualizedSidebarFlatSessionList {...props} />;
  }

  const {
    sessions,
    agentCatalog,
    activeSessionId,
    selectedSessionId,
    bookmarkedSessionIds,
    onSelectSession,
    onToggleBookmark,
    onRenameSession,
  } = props;

  return (
    <div className={`console-scrollbar ${SESSION_LIST_HEIGHT_CLASS} overflow-y-auto`}>
      <ul className="space-y-1">
        {sessions.map((sessionItem) => (
          <li key={sessionItem.slug}>
            <SessionRow
              session={sessionItem}
              agentCatalog={agentCatalog}
              active={activeSessionId === sessionItem.id}
              selected={selectedSessionId === sessionItem.id}
              bookmarkedSessionIds={bookmarkedSessionIds}
              onSelectSession={onSelectSession}
              onToggleBookmark={onToggleBookmark}
              onRenameSession={onRenameSession}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function VirtualizedSidebarFlatSessionList({
  sessions,
  agentCatalog,
  activeSessionId,
  selectedSessionId,
  bookmarkedSessionIds,
  onSelectSession,
  onToggleBookmark,
  onRenameSession,
}: SidebarFlatSessionListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const viewportRef = useRef(viewport);

  const updateViewport = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;

    const next = { scrollTop: node.scrollTop, height: node.clientHeight };
    const current = viewportRef.current;
    if (
      Math.abs(current.scrollTop - next.scrollTop) < 1 &&
      Math.abs(current.height - next.height) < 1
    ) {
      return;
    }

    viewportRef.current = next;
    setViewport(next);
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateViewport();
      });
    };

    node.addEventListener("scroll", scheduleUpdate, { passive: true });
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleUpdate) : null;
    resizeObserver?.observe(node);
    updateViewport();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [updateViewport]);

  const rowSpan = SESSION_ROW_SPAN_PX + SESSION_ROW_GAP_PX;
  const startIndex = Math.max(0, Math.floor(viewport.scrollTop / rowSpan) - SESSION_LIST_OVERSCAN);
  const endIndex = Math.min(
    sessions.length,
    Math.ceil((viewport.scrollTop + viewport.height) / rowSpan) + SESSION_LIST_OVERSCAN,
  );
  const visibleSessions = sessions.slice(startIndex, endIndex);
  const totalHeight = Math.max(0, sessions.length * rowSpan - SESSION_ROW_GAP_PX);

  return (
    <div
      ref={containerRef}
      className={`console-scrollbar ${SESSION_LIST_HEIGHT_CLASS} overflow-y-auto`}
    >
      <ul className="relative" style={{ height: totalHeight }}>
        {visibleSessions.map((sessionItem, offset) => {
          const index = startIndex + offset;
          return (
            <li
              key={sessionItem.slug}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${index * rowSpan}px)` }}
            >
              <SessionRow
                session={sessionItem}
                agentCatalog={agentCatalog}
                active={activeSessionId === sessionItem.id}
                selected={selectedSessionId === sessionItem.id}
                bookmarkedSessionIds={bookmarkedSessionIds}
                onSelectSession={onSelectSession}
                onToggleBookmark={onToggleBookmark}
                onRenameSession={onRenameSession}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
