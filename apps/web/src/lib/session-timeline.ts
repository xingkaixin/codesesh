/**
 * View model for the project timeline: keeps a flat session snapshot as
 * day-grouped tree references and derives bounded row pages from it. Pure —
 * expansion state belongs to the component, never to the model.
 */
import type { SessionHead, SessionReference, SessionTreeNode } from "@codesesh/core/contract";
import {
  addCalendarDays,
  buildSessionTree,
  getSessionAgentKey,
  getSessionRouteKey,
  groupSessionsByCalendarDay,
  startOfCalendarDay,
} from "@codesesh/core/contract";
import { formatMonthDay } from "./format";
import { getSessionDisplayTitle } from "./session-title";

export type SubSessionMode = "collapsed" | "expanded" | "hidden";

export const TIMELINE_MAIN_PAGE_SIZE = 40;
export const TIMELINE_CHILD_PAGE_SIZE = 40;

export interface TimelineChildRow {
  routeKey: string;
  reference: SessionReference;
  time: number;
  /**
   * Spawn mechanism label, e.g. "Task"/"subagent". `undefined` when unknown —
   * the badge is then not rendered. No adapter reports one today, so it is
   * always absent. Never invent a value.
   */
  kind?: string;
  title: string;
  /** The child's own stats: every descendant is listed as its own row. */
  messageCount: number;
  cost: number;
}

export interface TimelineRow {
  routeKey: string;
  reference: SessionReference;
  time: number;
  title: string;
  agentKey: string;
  /** Descendants at every depth. */
  childCount: number;
  /** Direct tree references only; descendant rows are derived one page at a time. */
  childRoots: readonly SessionTreeNode[];
  /** Inclusive of every descendant — the visible proof of the aggregation rule. */
  messageCount: number;
  tokens: number;
  cost: number;
  isOrphan: boolean;
}

export interface TimelineDay {
  dayKey: string;
  dayStart: number;
  /** "Today" | "Yesterday" | "08-04" */
  label: string;
  mainCount: number;
  subCount: number;
  /** Main-axis tree nodes; render rows are derived only for the visible page. */
  nodes: readonly SessionTreeNode[];
}

export interface TimelinePageDay {
  dayKey: string;
  dayStart: number;
  label: string;
  mainCount: number;
  subCount: number;
  rows: TimelineRow[];
}

export interface ProjectTimeline {
  days: TimelineDay[];
  orphanCount: number;
  mainCount: number;
  subCount: number;
  totalTokens: number;
}

export interface TimelinePage {
  days: TimelinePageDay[];
  offset: number;
  pageNumber: number;
  shown: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface TimelineChildPage {
  rows: TimelineChildRow[];
  offset: number;
  pageNumber: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function activityTime(session: SessionHead): number {
  return session.time_updated ?? session.time_created;
}

function referenceOf(session: SessionHead): SessionReference {
  return { agentName: getSessionAgentKey(session), sessionId: session.id };
}

function formatDayLabel(dayStart: number, now: number): string {
  const today = startOfCalendarDay(now);
  if (dayStart === today) return "Today";
  if (dayStart === addCalendarDays(today, -1)) return "Yesterday";
  const date = new Date(dayStart);
  return formatMonthDay(date.getTime());
}

function toChildRow(node: SessionTreeNode): TimelineChildRow {
  const { session } = node;
  const reference = referenceOf(session);
  return {
    routeKey: getSessionRouteKey(reference.agentName, reference.sessionId),
    reference,
    time: activityTime(session),
    title: getSessionDisplayTitle(session),
    messageCount: session.stats.message_count,
    cost: session.stats.total_cost ?? 0,
  };
}

function pushChildrenForDepthFirstTraversal(
  pending: SessionTreeNode[],
  children: readonly SessionTreeNode[],
): void {
  if (children.length === 1) {
    pending.push(children[0]!);
    return;
  }
  const ordered = children.toSorted((a, b) => activityTime(a.session) - activityTime(b.session));
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    pending.push(ordered[index]!);
  }
}

function getPageBounds(
  total: number,
  requestedOffset: number,
  limit: number,
): { offset: number; end: number } {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("page total must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("page limit must be a positive safe integer");
  }
  if (total === 0) return { offset: 0, end: 0 };
  const normalizedRequest =
    Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
  const pageOffset = normalizedRequest - (normalizedRequest % limit);
  const lastPageOffset = Math.floor((total - 1) / limit) * limit;
  const offset = Math.min(pageOffset, lastPageOffset);
  return { offset, end: offset + Math.min(limit, total - offset) };
}

function toRow(node: SessionTreeNode, isOrphan: boolean): TimelineRow {
  const { session, inclusiveStats } = node;
  const reference = referenceOf(session);

  return {
    routeKey: getSessionRouteKey(reference.agentName, reference.sessionId),
    reference,
    time: activityTime(session),
    title: getSessionDisplayTitle(session),
    agentKey: reference.agentName,
    childCount: node.descendantCount,
    childRoots: node.children,
    messageCount: inclusiveStats.messageCount,
    tokens: inclusiveStats.totalTokens,
    cost: inclusiveStats.cost,
    isOrphan,
  };
}

export function getTimelineChildPage(
  row: TimelineRow,
  requestedOffset = 0,
  limit = TIMELINE_CHILD_PAGE_SIZE,
): TimelineChildPage {
  const { offset, end } = getPageBounds(row.childCount, requestedOffset, limit);
  const rows: TimelineChildRow[] = [];
  const pending: SessionTreeNode[] = [];
  pushChildrenForDepthFirstTraversal(pending, row.childRoots);
  let index = 0;

  while (pending.length > 0 && index < end) {
    const child = pending.pop()!;
    if (index >= offset) rows.push(toChildRow(child));
    index += 1;
    pushChildrenForDepthFirstTraversal(pending, child.children);
  }

  return {
    rows,
    offset,
    pageNumber: Math.floor(offset / limit) + 1,
    hasPrevious: offset > 0,
    hasNext: end < row.childCount,
  };
}

export function getProjectTimelinePage(
  timeline: ProjectTimeline,
  requestedOffset = 0,
  limit = TIMELINE_MAIN_PAGE_SIZE,
): TimelinePage {
  const { offset, end } = getPageBounds(timeline.mainCount, requestedOffset, limit);
  const pageSize = end - offset;
  const days: TimelinePageDay[] = [];
  let skipped = 0;
  let shown = 0;

  for (const day of timeline.days) {
    if (shown === pageSize) break;
    const dayOffset = Math.max(0, offset - skipped);
    skipped += day.nodes.length;
    if (dayOffset >= day.nodes.length) continue;
    const nodes = day.nodes.slice(dayOffset, dayOffset + pageSize - shown);
    if (nodes.length === 0) continue;
    const rows = nodes.map((node) => toRow(node, node.session.parent_reference != null));
    days.push({
      dayKey: day.dayKey,
      dayStart: day.dayStart,
      label: day.label,
      mainCount: day.mainCount,
      subCount: day.subCount,
      rows,
    });
    shown += rows.length;
  }

  return {
    days,
    offset,
    pageNumber: Math.floor(offset / limit) + 1,
    shown,
    hasPrevious: offset > 0,
    hasNext: end < timeline.mainCount,
  };
}

export function buildProjectTimeline(
  sessions: SessionHead[],
  options?: { now?: number },
): ProjectTimeline {
  const tree = buildSessionTree(sessions);
  const now = options?.now ?? Date.now();

  const days = groupSessionsByCalendarDay(tree.entries).map<TimelineDay>((group) => ({
    dayKey: group.dayKey,
    dayStart: group.dayStart,
    label: formatDayLabel(group.dayStart, now),
    mainCount: group.mainCount,
    subCount: group.subCount,
    nodes: group.nodes,
  }));

  return {
    days,
    orphanCount: tree.orphans.length,
    mainCount: tree.entries.length,
    subCount: tree.entries.reduce((sum, node) => sum + node.descendantCount, 0),
    totalTokens: tree.entries.reduce((sum, node) => sum + node.inclusiveStats.totalTokens, 0),
  };
}

/** Pure helper the row component uses; no stored `expanded` field anywhere. */
export function isRowExpanded(
  row: TimelineRow,
  mode: SubSessionMode,
  openIds: ReadonlySet<string>,
): boolean {
  if (mode === "hidden" || row.childCount === 0) return false;
  return mode === "expanded" || openIds.has(row.routeKey);
}
