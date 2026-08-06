/**
 * View model for the project timeline: turns a flat session snapshot into
 * day-grouped rows whose sub-sessions live inside their parent row. Pure —
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
  /** Descendants at every depth, i.e. `children.length`. */
  childCount: number;
  /** Flattened descendants, depth-first, siblings oldest first. */
  children: TimelineChildRow[];
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
  rows: TimelineRow[];
}

export interface ProjectTimeline {
  days: TimelineDay[];
  orphanCount: number;
  mainCount: number;
  subCount: number;
  totalTokens: number;
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

function collectChildRows(node: SessionTreeNode, rows: TimelineChildRow[]): void {
  const ordered = node.children.toSorted(
    (a, b) => activityTime(a.session) - activityTime(b.session),
  );
  for (const child of ordered) {
    rows.push(toChildRow(child));
    collectChildRows(child, rows);
  }
}

function toRow(node: SessionTreeNode, isOrphan: boolean): TimelineRow {
  const { session, inclusiveStats } = node;
  const reference = referenceOf(session);
  const children: TimelineChildRow[] = [];
  collectChildRows(node, children);

  return {
    routeKey: getSessionRouteKey(reference.agentName, reference.sessionId),
    reference,
    time: activityTime(session),
    title: getSessionDisplayTitle(session),
    agentKey: reference.agentName,
    childCount: node.descendantCount,
    children,
    messageCount: inclusiveStats.messageCount,
    tokens: inclusiveStats.totalTokens,
    cost: inclusiveStats.cost,
    isOrphan,
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
    rows: group.nodes.map((node) => toRow(node, tree.mountStateOf(node.session) === "orphan")),
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
